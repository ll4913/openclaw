#!/usr/bin/env node
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_LARGE_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_SESSION_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_TOP = 30;

function parseArgs(argv) {
  const args = {
    stateDir: path.join(os.homedir(), ".openclaw"),
    logPath: path.join("/tmp", "openclaw", `openclaw-${new Date().toISOString().slice(0, 10)}.log`),
    top: DEFAULT_TOP,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--state-dir") {
      args.stateDir = requireValue(argv, ++i, arg);
    } else if (arg === "--log") {
      args.logPath = requireValue(argv, ++i, arg);
    } else if (arg === "--top") {
      args.top = parsePositiveInteger(requireValue(argv, ++i, arg), DEFAULT_TOP);
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function printHelp() {
  console.log(`Usage: node scripts/openclaw-hotspot-report.mjs [options]

Read-only OpenClaw workspace/runtime hotspot report.

Options:
  --state-dir <path>  OpenClaw state directory. Default: ~/.openclaw
  --log <path>        Gateway log to summarize. Default: today's /tmp/openclaw log
  --top <n>           Number of largest entries to show. Default: 30
  --json              Emit JSON instead of Markdown
  -h, --help          Show help
`);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function toDisplayPath(filePath, stateDir) {
  const rel = path.relative(stateDir, filePath);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    return rel || ".";
  }
  return filePath;
}

async function safeLstat(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch {
    return null;
  }
}

async function safeReaddir(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function dirSize(root, options = {}) {
  const maxDepth = options.maxDepth ?? 12;
  const stack = [{ dir: root, depth: 0 }];
  let bytes = 0;
  let files = 0;
  let dirs = 0;
  let skipped = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || current.depth > maxDepth) {
      skipped += 1;
      continue;
    }
    dirs += 1;
    for (const entry of await safeReaddir(current.dir)) {
      const fullPath = path.join(current.dir, entry.name);
      const stat = await safeLstat(fullPath);
      if (!stat) {
        skipped += 1;
        continue;
      }
      if (entry.isSymbolicLink()) {
        skipped += 1;
        continue;
      }
      if (entry.isDirectory()) {
        stack.push({ dir: fullPath, depth: current.depth + 1 });
        continue;
      }
      if (entry.isFile()) {
        bytes += stat.size;
        files += 1;
      }
    }
  }
  return { path: root, bytes, files, dirs, skipped };
}

async function listTopLevelDirs(stateDir, prefix) {
  const entries = await safeReaddir(stateDir);
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(stateDir, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

async function listAgentDirs(stateDir) {
  const agentsDir = path.join(stateDir, "agents");
  const entries = await safeReaddir(agentsDir);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(agentsDir, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function shouldSkipScanDir(name) {
  return name === "node_modules" || name === ".next" || name === "dist" || name === "build";
}

async function findFiles(rootDirs, predicate, options = {}) {
  const maxDepth = options.maxDepth ?? 6;
  const results = [];
  const stack = rootDirs.map((dir) => ({ dir, depth: 0 }));
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || current.depth > maxDepth) {
      continue;
    }
    for (const entry of await safeReaddir(current.dir)) {
      const fullPath = path.join(current.dir, entry.name);
      const stat = await safeLstat(fullPath);
      if (!stat || entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!shouldSkipScanDir(entry.name)) {
          stack.push({ dir: fullPath, depth: current.depth + 1 });
        }
        continue;
      }
      if (entry.isFile() && predicate(fullPath, stat)) {
        results.push({ path: fullPath, bytes: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }
  return results.sort((left, right) => right.bytes - left.bytes);
}

async function summarizeLog(logPath) {
  const summary = {
    path: logPath,
    exists: false,
    livenessWarnings: 0,
    stalledSessions: 0,
    telegramNetworkFailures: 0,
    fetchTimeouts: 0,
    shutdowns: 0,
    gatewayReady: 0,
    prepProgress: {},
    activeWork: {},
    maxEventLoopDelayMs: 0,
    maxEventLoopUtilization: 0,
    maxCpuCoreRatio: 0,
  };
  const stat = await safeLstat(logPath);
  if (!stat?.isFile()) {
    return summary;
  }
  summary.exists = true;

  const rl = readline.createInterface({
    input: createReadStream(logPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const message = extractLogMessage(line);
    if (!message) {
      continue;
    }
    if (message.includes("liveness warning:")) {
      summary.livenessWarnings += 1;
      updateNumberMax(summary, "maxEventLoopDelayMs", /eventLoopDelayMaxMs=([0-9.]+)/u, message);
      updateNumberMax(
        summary,
        "maxEventLoopUtilization",
        /eventLoopUtilization=([0-9.]+)/u,
        message,
      );
      updateNumberMax(summary, "maxCpuCoreRatio", /cpuCoreRatio=([0-9.]+)/u, message);
      for (const key of extractActiveWorkKeys(message)) {
        summary.activeWork[key] = (summary.activeWork[key] ?? 0) + 1;
      }
    }
    if (message.includes("stalled session:")) {
      summary.stalledSessions += 1;
    }
    if (
      message.includes("telegram sendMessage failed") ||
      message.includes("telegram sendChatAction failed") ||
      message.includes("telegram setMessageReaction failed")
    ) {
      summary.telegramNetworkFailures += 1;
    }
    if (message.includes("fetch timeout reached")) {
      summary.fetchTimeouts += 1;
    }
    if (message.includes("shutdown started: gateway stopping")) {
      summary.shutdowns += 1;
    }
    if (message.includes("gateway ready")) {
      summary.gatewayReady += 1;
    }
    if (message.includes("[trace:embedded-run] prep progress:")) {
      const stage = /reason=embedded_run:prep:([^ ]+)/u.exec(message)?.[1] ?? "unknown";
      summary.prepProgress[stage] = (summary.prepProgress[stage] ?? 0) + 1;
    }
  }
  return summary;
}

function extractLogMessage(line) {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed.message === "string") {
      return parsed.message;
    }
    if (typeof parsed["1"] === "string") {
      return parsed["1"];
    }
  } catch {
    // fall through
  }
  return line;
}

function updateNumberMax(target, field, regex, message) {
  const match = regex.exec(message);
  if (!match) {
    return;
  }
  const value = Number.parseFloat(match[1]);
  if (Number.isFinite(value)) {
    target[field] = Math.max(target[field], value);
  }
}

function extractActiveWorkKeys(message) {
  const workText = /work=\[([^\]]*)\]/u.exec(message)?.[1];
  if (!workText) {
    return [];
  }
  return workText
    .split("|")
    .map((entry) => entry.trim().replace(/\(.*/u, "").trim())
    .map((entry) => entry.replace(/^active=/u, ""))
    .filter(Boolean);
}

async function summarizeLeases(stateDir) {
  const leasePath = path.join(stateDir, "acpx", "process-leases.json");
  const summary = { path: leasePath, exists: false, total: 0, open: 0, lost: 0, closed: 0 };
  try {
    const raw = await fs.readFile(leasePath, "utf8");
    const parsed = JSON.parse(raw);
    const leases = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.leases)
        ? parsed.leases
        : [];
    summary.exists = true;
    summary.total = leases.length;
    for (const lease of leases) {
      const state = String(lease?.state ?? lease?.status ?? "").toLowerCase();
      if (state === "open") {
        summary.open += 1;
      }
      if (state === "lost") {
        summary.lost += 1;
      }
      if (state === "closed") {
        summary.closed += 1;
      }
    }
  } catch {
    // leave exists=false
  }
  return summary;
}

async function buildReport(args) {
  const stateDir = path.resolve(args.stateDir);
  const workspaceDirs = await listTopLevelDirs(stateDir, "workspace");
  const agentDirs = await listAgentDirs(stateDir);
  const rootDirs = [...workspaceDirs, ...agentDirs];

  const [workspaceSizes, agentSizes, largeFiles, dreamFiles, sessionFiles, log, leases] =
    await Promise.all([
      Promise.all(workspaceDirs.map((dir) => dirSize(dir, { maxDepth: 12 }))),
      Promise.all(agentDirs.map((dir) => dirSize(dir, { maxDepth: 12 }))),
      findFiles(rootDirs, (_filePath, stat) => stat.size >= DEFAULT_LARGE_FILE_BYTES, {
        maxDepth: 7,
      }),
      findFiles(rootDirs, (filePath) => filePath.includes(`${path.sep}.dreams${path.sep}`), {
        maxDepth: 8,
      }),
      findFiles(
        rootDirs,
        (filePath, stat) =>
          filePath.includes(`${path.sep}sessions${path.sep}`) &&
          filePath.endsWith(".json") &&
          stat.size >= DEFAULT_SESSION_FILE_BYTES,
        { maxDepth: 8 },
      ),
      summarizeLog(path.resolve(args.logPath)),
      summarizeLeases(stateDir),
    ]);

  return {
    generatedAt: new Date().toISOString(),
    stateDir,
    workspaceSizes: workspaceSizes
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, args.top),
    agentSizes: agentSizes.sort((left, right) => right.bytes - left.bytes).slice(0, args.top),
    largeFiles: largeFiles.slice(0, args.top),
    dreamFiles: dreamFiles.slice(0, args.top),
    sessionFiles: sessionFiles.slice(0, args.top),
    log,
    leases,
  };
}

function renderTable(rows, stateDir) {
  if (rows.length === 0) {
    return "_none_";
  }
  return [
    "| Size | Path |",
    "| ---: | --- |",
    ...rows.map(
      (row) => `| ${formatBytes(row.bytes)} | \`${toDisplayPath(row.path, stateDir)}\` |`,
    ),
  ].join("\n");
}

function renderMarkdown(report) {
  const activeWork = Object.entries(report.log.activeWork)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 12)
    .map(([key, count]) => `- \`${key}\`: ${count}`)
    .join("\n");
  const prepProgress = Object.entries(report.log.prepProgress)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 12)
    .map(([key, count]) => `- \`${key}\`: ${count}`)
    .join("\n");

  return `# OpenClaw Hotspot Report

Generated: ${report.generatedAt}
State dir: \`${report.stateDir}\`

## Gateway Log Signals

- Log exists: ${report.log.exists}
- Liveness warnings: ${report.log.livenessWarnings}
- Stalled sessions: ${report.log.stalledSessions}
- Telegram network failures: ${report.log.telegramNetworkFailures}
- Fetch timeouts: ${report.log.fetchTimeouts}
- Gateway ready events: ${report.log.gatewayReady}
- Shutdown events: ${report.log.shutdowns}
- Max event loop delay: ${report.log.maxEventLoopDelayMs.toFixed(1)} ms
- Max event loop utilization: ${report.log.maxEventLoopUtilization.toFixed(3)}
- Max CPU/core ratio: ${report.log.maxCpuCoreRatio.toFixed(3)}

## Active Work Seen In Liveness Warnings

${activeWork || "_none_"}

## Prep Progress Markers

${prepProgress || "_none_"}

## ACP Lease Summary

- Lease file exists: ${report.leases.exists}
- Total: ${report.leases.total}
- Open: ${report.leases.open}
- Lost: ${report.leases.lost}
- Closed: ${report.leases.closed}

## Largest Workspaces

${renderTable(report.workspaceSizes, report.stateDir)}

## Largest Agent State Dirs

${renderTable(report.agentSizes, report.stateDir)}

## Large Files

${renderTable(report.largeFiles, report.stateDir)}

## Largest .dreams Files

${renderTable(report.dreamFiles, report.stateDir)}

## Large Session Files

${renderTable(report.sessionFiles, report.stateDir)}
`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildReport(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderMarkdown(report));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
