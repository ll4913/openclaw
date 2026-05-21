#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const openclawLauncher = path.join(repoRoot, "openclaw.mjs");

const result = spawnSync(
  process.execPath,
  [openclawLauncher, "agent-quality", "check", ...process.argv.slice(2)],
  {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(`agent-quality gate failed to start: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
