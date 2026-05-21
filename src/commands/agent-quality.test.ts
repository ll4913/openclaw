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
    getGatewayStatus: async () => ({
      ok: true,
      warnings: [],
      service: { runtime: { status: "running", pid: 1234 } },
      rpc: { ok: true },
      health: { healthy: true },
      port: { listeners: [{ pid: 1234, command: "node" }] },
    }),
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
      [
        "GEMINI_API_KEY=test-gemini",
        "XAI_API_KEY=test-xai",
        JSON.stringify({
          time: "2026-05-21T07:59:00.000Z",
          level: "info",
          msg: "gateway heartbeat",
        }),
      ].join("\n"),
    pathExists: async () => true,
    ...overrides,
  };
}

describe("agent quality gate", () => {
  it("passes when gateway, runtime, Telegram, logs, and regression coverage are healthy", async () => {
    const report = await runAgentQualityGate({ repoRoot: "/repo" }, healthyDeps());

    expect(report.overall).toBe("pass");
    expect(report.summary).toEqual({ pass: 7, warn: 0, fail: 0 });
    expect(report.checks.map((check) => check.id)).toEqual([
      "gateway-liveness",
      "gateway-readiness",
      "health",
      "telegram-channels",
      "gateway-log",
      "environment-doctor",
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
          service: { runtime: { status: "running", pid: 1234 } },
          health: { healthy: true },
          port: { listeners: [{ pid: 1234, command: "node" }] },
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
    expect(report.checks.find((entry) => entry.id === "gateway-liveness")?.status).toBe("pass");
    expect(report.checks.find((entry) => entry.id === "gateway-readiness")?.summary).toBe(
      "connect EPERM 127.0.0.1:18789",
    );
    expect(report.checks.find((entry) => entry.id === "health")?.summary).toBe(
      "gateway closed (1006 abnormal closure)",
    );
    expect(report.checks.find((entry) => entry.id === "telegram-channels")?.summary).toBe(
      "gateway closed",
    );
    expect(report.likelyCauses.map((cause) => cause.id)).toContain("rpc_timeout_or_stall");
    expect(report.runbook.map((item) => item.id)).toContain("rpc_timeout_or_stall");
  });

  it("fails gateway probes quickly when a command exceeds the probe budget", async () => {
    const report = await runAgentQualityGate(
      { repoRoot: "/repo", logs: false, timeoutMs: 5 },
      healthyDeps({
        getGatewayStatus: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { ok: true };
        },
      }),
    );

    expect(report.overall).toBe("fail");
    expect(report.checks.find((entry) => entry.id === "gateway-liveness")?.summary).toBe(
      "Gateway status probe timed out after 5ms",
    );
    expect(report.checks.find((entry) => entry.id === "gateway-readiness")?.summary).toBe(
      "Gateway status probe timed out after 5ms",
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
    expect(report.likelyCauses.map((cause) => cause.id)).toContain("duplicate_telegram_poller");
    expect(report.runbook.map((item) => item.id)).toContain("duplicate_telegram_poller");
    expect(formatAgentQualityReport(report)).toContain("Likely Causes:");
  });

  it("classifies memory pressure and gives a runbook suggestion", async () => {
    const report = await runAgentQualityGate(
      { repoRoot: "/repo", sinceMinutes: 15 },
      healthyDeps({
        readTextFile: async () =>
          [
            JSON.stringify({
              time: "2026-05-21T07:58:00.000Z",
              level: "warn",
              message:
                "memory pressure: level=warning reason=rss_threshold rssBytes=2200000000 heapUsedBytes=600000000 thresholdBytes=1610612736",
            }),
          ].join("\n"),
      }),
    );

    expect(report.overall).toBe("warn");
    expect(report.likelyCauses.map((cause) => cause.id)).toContain("memory_pressure");
    expect(report.runbook.find((item) => item.id === "memory_pressure")?.steps[0]).toContain(
      "RSS/heap trend",
    );
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

  it("warns on missing provider key sources or runtime artifacts without exposing secrets", async () => {
    const report = await runAgentQualityGate(
      { repoRoot: "/repo", logs: false },
      healthyDeps({
        readTextFile: async () => "",
        pathExists: async (filePath) => !filePath.endsWith("telegram-ingress-worker.runtime.js"),
      }),
    );

    const check = report.checks.find((entry) => entry.id === "environment-doctor");
    expect(report.overall).toBe("warn");
    expect(check?.status).toBe("warn");
    expect(check?.details).toContain("Gemini key source missing (GEMINI_API_KEY/GOOGLE_API_KEY)");
    expect(check?.details).toContain(
      "xAI/Grok key source missing (XAI_API_KEY/GROK_API_KEY/X_AI_API_KEY)",
    );
    expect(check?.details).toContain("dist/telegram-ingress-worker.runtime.js missing");
    expect(JSON.stringify(check)).not.toContain("test-gemini");
    expect(report.likelyCauses.map((cause) => cause.id)).toContain("dist_artifact_missing");
    expect(report.runbook.map((item) => item.id)).toContain("dist_artifact_missing");
  });

  it("classifies provider auth errors when logs contain auth failure evidence", async () => {
    const report = await runAgentQualityGate(
      { repoRoot: "/repo", sinceMinutes: 15 },
      healthyDeps({
        readTextFile: async () =>
          [
            JSON.stringify({
              time: "2026-05-21T07:58:00.000Z",
              level: "error",
              message: 'Missing API key for provider "openai-codex"',
            }),
          ].join("\n"),
      }),
    );

    expect(report.likelyCauses.map((cause) => cause.id)).toContain("provider_auth_error");
    expect(report.runbook.map((item) => item.id)).toContain("provider_auth_error");
  });

  it("does not classify timestamp millisecond 401 values as provider auth errors", async () => {
    const report = await runAgentQualityGate(
      { repoRoot: "/repo", sinceMinutes: 15 },
      healthyDeps({
        readTextFile: async () =>
          [
            "GEMINI_API_KEY=test-gemini",
            "XAI_API_KEY=test-xai",
            JSON.stringify({
              time: "2026-05-21T13:30:04.401+08:00",
              level: "info",
              message: "[lcm] auto-rotate: phase=runtime action=skip reason=below-threshold",
            }),
          ].join("\n"),
      }),
    );

    expect(report.overall).toBe("pass");
    expect(report.likelyCauses.map((cause) => cause.id)).not.toContain("provider_auth_error");
  });

  it("classifies missing dist modules as runtime artifact drift", async () => {
    const report = await runAgentQualityGate(
      { repoRoot: "/repo", sinceMinutes: 15 },
      healthyDeps({
        readTextFile: async () =>
          [
            "GEMINI_API_KEY=test-gemini",
            "XAI_API_KEY=test-xai",
            JSON.stringify({
              time: "2026-05-21T07:58:00.000Z",
              level: "error",
              message:
                "lane task error: Error: Cannot find module '/Users/lianglin/openclaw/dist/plugin-sdk/channel-targets.js'",
            }),
          ].join("\n"),
      }),
    );

    expect(report.overall).toBe("fail");
    expect(report.likelyCauses.map((cause) => cause.id)).toContain("dist_artifact_missing");
    expect(report.runbook.map((item) => item.id)).toContain("dist_artifact_missing");
  });
});
