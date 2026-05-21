import type { Command } from "commander";
import { agentQualityCheckCommand } from "../commands/agent-quality.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { formatHelpExamples } from "./help-format.js";

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function registerAgentQualityCli(program: Command) {
  const agentQuality = program
    .command("agent-quality")
    .description("Run read-only quality gates for OpenClaw agents")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw agent-quality check", "Run all read-only agent quality checks."],
          ["openclaw agent-quality check --json", "Emit machine-readable gate output."],
          [
            "openclaw agent-quality check --since-minutes 30",
            "Scan the last 30 minutes of gateway logs.",
          ],
          ["openclaw agent-quality check --no-logs", "Skip gateway log scanning."],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink(
          "/cli/agent-quality",
          "docs.openclaw.ai/cli/agent-quality",
        )}\n`,
    )
    .action(() => {
      agentQuality.help({ error: true });
    });

  agentQuality
    .command("check")
    .description("Run gateway, runtime, Telegram, log, and regression coverage checks")
    .option("--json", "Output JSON", false)
    .option("--since-minutes <minutes>", "Gateway log scan window", "15")
    .option("--timeout <ms>", "Gateway command timeout in ms", "10000")
    .option("--no-logs", "Skip gateway log scanning")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await agentQualityCheckCommand(
          {
            json: Boolean(opts.json),
            logs: opts.logs !== false,
            sinceMinutes: parsePositiveInteger(opts.sinceMinutes, 15),
            timeoutMs: parsePositiveInteger(opts.timeout, 10_000),
          },
          defaultRuntime,
        );
      });
    });
}
