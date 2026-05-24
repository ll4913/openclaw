import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("./embedded-pi-mcp.js");
  vi.doUnmock("./mcp-transport.js");
  vi.doUnmock("@modelcontextprotocol/sdk/client/index.js");
  vi.resetModules();
});

describe("session MCP runtime startup", () => {
  it("starts configured MCP servers concurrently when building the catalog", async () => {
    let resolveSlowConnect: (() => void) | undefined;
    const slowConnect = new Promise<void>((resolve) => {
      resolveSlowConnect = resolve;
    });
    const connectStarted: string[] = [];

    vi.doMock("./embedded-pi-mcp.js", () => ({
      loadEmbeddedPiMcpConfig: () => ({
        diagnostics: [],
        mcpServers: {
          slow: { command: "slow-server" },
          fast: { command: "fast-server" },
        },
      }),
    }));
    vi.doMock("./mcp-transport.js", () => ({
      resolveMcpTransport: (serverName: string) => ({
        transport: {
          serverName,
          close: async () => {},
        },
        description: `${serverName} stdio`,
        transportType: "stdio",
        connectionTimeoutMs: 1_000,
        detachStderr: undefined,
      }),
    }));
    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: class {
        private serverName = "";

        async connect(transport: { serverName: string }) {
          this.serverName = transport.serverName;
          connectStarted.push(this.serverName);
          if (this.serverName === "slow") {
            await slowConnect;
          }
        }

        async listTools() {
          return {
            tools: [
              {
                name: `${this.serverName}_tool`,
                description: `${this.serverName} tool`,
                inputSchema: { type: "object" },
              },
            ],
          };
        }

        async close() {}
      },
    }));

    const { createSessionMcpRuntime } = await import("./pi-bundle-mcp-runtime.js");
    const runtime = createSessionMcpRuntime({
      sessionId: "session-concurrent-startup",
      workspaceDir: "/workspace",
    });

    const catalogPromise = runtime.getCatalog();
    await vi.waitFor(() => {
      expect(connectStarted).toEqual(expect.arrayContaining(["slow", "fast"]));
    });

    resolveSlowConnect?.();
    const catalog = await catalogPromise;

    expect(catalog.tools.map((tool) => tool.toolName)).toEqual(["slow_tool", "fast_tool"]);
  });
});
