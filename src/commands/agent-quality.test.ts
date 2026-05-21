import { describe, expect, it } from "vitest";
import {
  formatAgentQualityReport,
  runAgentQualityGate,
  type AgentQualityDeps,
} from "./agent-quality.js";

const NOW = new Date("2026-05-21T08:00:00.000Z");

function healthyDeps(overrides: Partial<AgentQualityDeps> = {}): AgentQualityDeps {
  return {
    now: () => NOW,
    getGatewayStatus: async () => ({ ok: true, warnings: [] }),
    getHealth: async () => ({ eventLoop: { degraded: false, reasons: [] } }),
    getChannelsStatus: async () => ({
      channelAccounts: {
        telegram: [
          {
            accountId: "main",
            configured: true,
            enabled: true,
            running: true,
            connected: true,
          },
        ],
      },
    }),
    findLatestLogFile: async () => "/tmp/openclaw/openclaw-2026-05-21.log",
    readTextFile: async () =>
      JSON.stringify({
        time: "2026-05-21T07:59:00.000Z",
        level: "info",
        msg: "gateway heartbeat",
      }),
    pathExists: async () => true,
    ...overrides,
  };
}

describe("agent quality gate", () => {
  it("passes when gateway, runtime, Telegram, logs, and regression coverage are healthy", async () => {
    const report = await runAgentQualityGate({ repoRoot: "/repo" }, healthyDeps());

    expect(report.overall).toBe("pass");
    expect(report.summary).toEqual({ pass: 5, warn: 0, fail: 0 });
    expect(report.checks.map((check) => check.id)).toEqual([
      "gateway",
      "health",
      "telegram-channels",
      "gateway-log",
      "regression-coverage",
    ]);
  });

  it("fails when an enabled Telegram account is disconnected or stopped", async () => {
    const report = await runAgentQualityGate(
      { repoRoot: "/repo" },
      healthyDeps({
        getChannelsStatus: async () => ({
          channelAccounts: {
            telegram: [
              {
                accountId: "bot",
                configured: true,
                enabled: true,
                running: false,
                connected: false,
                lastError: "polling conflict",
              },
            ],
          },
        }),
      }),
    );

    const check = report.checks.find((entry) => entry.id === "telegram-channels");
    expect(report.overall).toBe("fail");
    expect(check?.status).toBe("fail");
    expect(check?.details).toEqual([
      "telegram:bot is enabled but stopped.",
      "telegram:bot is enabled but disconnected.",
      "telegram:bot lastError=polling conflict",
    ]);
  });

  it("fails visibly when gateway RPC health or channel status is unreachable", async () => {
    const report = await runAgentQualityGate(
      { repoRoot: "/repo", logs: false },
      healthyDeps({
        getGatewayStatus: async () => ({
          rpc: { ok: false, error: "connect EPERM 127.0.0.1:18789" },
        }),
        getHealth: async () => ({
          ok: false,
          error: { message: "gateway closed (1006 abnormal closure)" },
        }),
        getChannelsStatus: async () => ({
          gatewayReachable: false,
          error: "gateway closed\nRun `openclaw doctor` for diagnostics.",
        }),
      }),
    );

    expect(report.overall).toBe("fail");
    expect(report.checks.find((entry) => entry.id === "gateway")?.summary).toBe(
      "connect EPERM 127.0.0.1:18789",
    );
    expect(report.checks.find((entry) => entry.id === "health")?.summary).toBe(
      "gateway closed (1006 abnormal closure)",
    );
    expect(report.checks.find((entry) => entry.id === "telegram-channels")?.summary).toBe(
      "gateway closed",
    );
  });

  it("fails on recent fatal ACP or channel log events", async () => {
    const report = await runAgentQualityGate(
      { repoRoot: "/repo", sinceMinutes: 15 },
      healthyDeps({
        readTextFile: async () =>
          [
            JSON.stringify({
              time: "2026-05-21T07:55:00.000Z",
              level: "error",
              msg: "ACP_TURN_FAILED stream disconnected before completion",
            }),
          ].join("\n"),
      }),
    );

    const check = report.checks.find((entry) => entry.id === "gateway-log");
    expect(report.overall).toBe("fail");
    expect(check?.status).toBe("fail");
    expect(check?.summary).toContain("recent fatal");
  });

  it("warns on recoverable Telegram polling conflicts", async () => {
    const report = await runAgentQualityGate(
      { repoRoot: "/repo", sinceMinutes: 15 },
      healthyDeps({
        readTextFile: async () =>
          [
            JSON.stringify({
              time: "2026-05-21T07:58:00.000Z",
              level: "warn",
              message: "isolated polling cycle error reason=getUpdates conflict",
            }),
            JSON.stringify({
              time: "2026-05-21T07:59:00.000Z",
              level: "warn",
              message: "isolated polling cycle error reason=getUpdates conflict",
            }),
          ].join("\n"),
      }),
    );

    const check = report.checks.find((entry) => entry.id === "gateway-log");
    expect(report.overall).toBe("warn");
    expect(check?.status).toBe("warn");
    expect(check?.summary).toContain("2 recent");
    expect(check?.details).toHaveLength(1);
    expect(formatAgentQualityReport(report)).toContain("Agent Quality Gate: WARN");
  });

  it("warns when expected ACP and Telegram regression tests are missing", async () => {
    const report = await runAgentQualityGate(
      { repoRoot: "/repo" },
      healthyDeps({
        pathExists: async (filePath) => !filePath.endsWith("dispatch-acp.test.ts"),
      }),
    );

    const check = report.checks.find((entry) => entry.id === "regression-coverage");
    expect(report.overall).toBe("warn");
    expect(check?.status).toBe("warn");
    expect(check?.details).toEqual(["src/auto-reply/reply/dispatch-acp.test.ts"]);
  });
});
