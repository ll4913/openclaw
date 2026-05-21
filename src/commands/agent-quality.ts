import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatErrorMessage } from "../infra/errors.js";
import { type OutputRuntimeEnv, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { channelsStatusCommand } from "./channels/status.js";
import { gatewayStatusCommand } from "./gateway-status.js";
import { healthCommand } from "./health.js";

export type AgentQualityStatus = "pass" | "warn" | "fail";

export type AgentQualityCheck = {
  id: string;
  name: string;
  status: AgentQualityStatus;
  summary: string;
  details?: string[];
};

export type AgentQualityCauseId =
  | "dist_artifact_missing"
  | "duplicate_telegram_poller"
  | "gateway_restart_window"
  | "memory_pressure"
  | "provider_auth_error"
  | "rpc_timeout_or_stall";

export type AgentQualityCause = {
  id: AgentQualityCauseId;
  status: AgentQualityStatus;
  summary: string;
  evidence: string[];
};

export type AgentQualityRunbookSuggestion = {
  id: AgentQualityCauseId;
  title: string;
  steps: string[];
};

export type ArtifactIntegrityState = "missing_now" | "stale_reference" | "historical";

export type ArtifactIntegrityFinding = {
  filePath: string;
  state: ArtifactIntegrityState;
  evidence: string[];
};

export type AgentQualityReport = {
  generatedAt: string;
  overall: AgentQualityStatus;
  checks: AgentQualityCheck[];
  likelyCauses: AgentQualityCause[];
  runbook: AgentQualityRunbookSuggestion[];
  logFile?: string | null;
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
};

export type AgentQualityOptions = {
  json?: boolean;
  sinceMinutes?: number | string;
  logs?: boolean;
  timeoutMs?: number;
  repoRoot?: string;
};

export type AgentQualityDeps = {
  now?: () => Date;
  getGatewayStatus?: () => Promise<unknown>;
  getHealth?: () => Promise<unknown>;
  getChannelsStatus?: () => Promise<unknown>;
  findLatestLogFile?: () => Promise<string | null>;
  readTextFile?: (filePath: string) => Promise<string>;
  pathExists?: (filePath: string) => Promise<boolean>;
};

type CaptureRuntime = OutputRuntimeEnv & {
  jsonValues: unknown[];
  logs: string[];
  errors: string[];
};

const DEFAULT_SINCE_MINUTES = 15;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_LOG_DIR = "/tmp/openclaw";
const LOG_SCAN_MAX_LINES = 5000;
const CURRENT_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILES = [
  path.join(homedir(), ".openclaw/service-env/ai.openclaw.gateway.env"),
  path.join(homedir(), ".openclaw/.env"),
];

class CaptureExitError extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function findOpenClawRepoRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  for (;;) {
    if (
      existsSync(path.join(current, "package.json")) &&
      existsSync(path.join(current, "openclaw.mjs"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveDefaultRepoRoot(): string {
  return (
    findOpenClawRepoRoot(process.cwd()) ??
    findOpenClawRepoRoot(CURRENT_MODULE_DIR) ??
    path.resolve(CURRENT_MODULE_DIR, "../..")
  );
}

function createCaptureRuntime(): CaptureRuntime {
  const runtime: CaptureRuntime = {
    jsonValues: [],
    logs: [],
    errors: [],
    log: (...args) => runtime.logs.push(args.map(String).join(" ")),
    error: (...args) => runtime.errors.push(args.map(String).join(" ")),
    writeStdout: (value) => runtime.logs.push(value),
    writeJson: (value) => runtime.jsonValues.push(value),
    exit: (code) => {
      throw new CaptureExitError(code);
    },
  };
  return runtime;
}

async function captureJsonCommand(
  run: (runtime: CaptureRuntime) => Promise<void>,
): Promise<unknown> {
  const runtime = createCaptureRuntime();
  try {
    await run(runtime);
  } catch (err) {
    const hasJson =
      runtime.jsonValues.length > 0 || runtime.logs.some((line) => line.trim().startsWith("{"));
    if (!(err instanceof CaptureExitError) || !hasJson) {
      throw err;
    }
  }
  if (runtime.jsonValues.length > 0) {
    return runtime.jsonValues.at(-1);
  }
  const jsonText = runtime.logs.find((line) => line.trim().startsWith("{"));
  if (jsonText) {
    return JSON.parse(jsonText);
  }
  return {
    logs: runtime.logs,
    errors: runtime.errors,
  };
}

async function defaultGetGatewayStatus(timeoutMs: number): Promise<unknown> {
  return await captureJsonCommand(async (runtime) => {
    await gatewayStatusCommand({ json: true, timeout: timeoutMs }, runtime);
  });
}

async function defaultGetHealth(timeoutMs: number): Promise<unknown> {
  return await captureJsonCommand(async (runtime) => {
    await healthCommand({ json: true, timeoutMs }, runtime);
  });
}

async function defaultGetChannelsStatus(timeoutMs: number): Promise<unknown> {
  return await captureJsonCommand(async (runtime) => {
    await channelsStatusCommand({ json: true, timeout: String(timeoutMs) }, runtime);
  });
}

async function defaultFindLatestLogFile(): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(DEFAULT_LOG_DIR);
  } catch {
    return null;
  }
  const candidates = await Promise.all(
    entries
      .filter((entry) => /^openclaw-\d{4}-\d{2}-\d{2}\.log$/u.test(entry))
      .map(async (entry) => {
        const filePath = path.join(DEFAULT_LOG_DIR, entry);
        try {
          const fileStat = await stat(filePath);
          return { filePath, mtimeMs: fileStat.mtimeMs };
        } catch {
          return null;
        }
      }),
  );
  const sorted = candidates
    .filter((entry): entry is { filePath: string; mtimeMs: number } => Boolean(entry))
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs);
  return sorted[0]?.filePath ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(asRecord(entry)))
    : [];
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && typeof (value as { then?: unknown }).then === "function");
}

function statusRank(status: AgentQualityStatus): number {
  return status === "fail" ? 2 : status === "warn" ? 1 : 0;
}

function summarizeOverall(checks: AgentQualityCheck[]): AgentQualityReport["summary"] {
  return {
    pass: checks.filter((check) => check.status === "pass").length,
    warn: checks.filter((check) => check.status === "warn").length,
    fail: checks.filter((check) => check.status === "fail").length,
  };
}

function resolveOverall(checks: AgentQualityCheck[]): AgentQualityStatus {
  return checks.reduce<AgentQualityStatus>(
    (current, check) => (statusRank(check.status) > statusRank(current) ? check.status : current),
    "pass",
  );
}

function collectCheckText(checks: AgentQualityCheck[]): string[] {
  return checks.flatMap((check) => [
    `${check.name}: ${check.summary}`,
    ...(check.details ?? []).map((detail) => `${check.name}: ${detail}`),
  ]);
}

function findEvidence(lines: string[], patterns: RegExp[], limit = 3): string[] {
  const evidence: string[] = [];
  for (const line of lines) {
    if (!patterns.some((pattern) => pattern.test(line))) {
      continue;
    }
    if (!evidence.includes(line)) {
      evidence.push(line);
    }
    if (evidence.length >= limit) {
      break;
    }
  }
  return evidence;
}

function buildCause(
  id: AgentQualityCauseId,
  status: AgentQualityStatus,
  summary: string,
  evidence: string[],
): AgentQualityCause | null {
  return evidence.length > 0 ? { id, status, summary, evidence } : null;
}

function classifyLikelyCauses(checks: AgentQualityCheck[]): AgentQualityCause[] {
  const lines = collectCheckText(checks);
  const causes = [
    buildCause(
      "dist_artifact_missing",
      "warn",
      "A required runtime artifact is missing; rebuild before trusting gateway startup.",
      findEvidence(lines, [
        /(?:missing_now|stale_reference): .*\/dist\//u,
        /dist\/telegram-ingress-worker\.runtime\.js missing/u,
        /Cannot find module .*\/dist\//u,
        /dist\/plugin-sdk\//u,
      ]),
    ),
    buildCause(
      "duplicate_telegram_poller",
      "warn",
      "Telegram getUpdates conflicts suggest a duplicate or stale poller for at least one bot token.",
      findEvidence(lines, [/getUpdates conflict/u, /terminated by other getUpdates request/u]),
    ),
    buildCause(
      "gateway_restart_window",
      "warn",
      "Recent gateway restart/stale-process events may explain transient probe failures.",
      findEvidence(lines, [/stale gateway process/u, /\brestart(?:ing|ed)?\b/u]),
    ),
    buildCause(
      "memory_pressure",
      "warn",
      "Gateway RSS/heap pressure is above the warning threshold and can slow CLI/RPC probes.",
      findEvidence(lines, [/memory pressure/u, /rss_threshold/u]),
    ),
    buildCause(
      "provider_auth_error",
      "fail",
      "Provider authentication errors are present and may block agent turns.",
      findEvidence(lines, [
        /\bauth(?:entication)? errors?\b/iu,
        /Missing API key/iu,
        /(?:HTTP|status|code|errorCode|response)[^\n]{0,40}\b401\b/iu,
        /\b401 Unauthorized\b/iu,
        /Invalid authentication credentials/iu,
      ]),
    ),
    buildCause(
      "rpc_timeout_or_stall",
      "fail",
      "Gateway RPC/readiness path is timing out or closing abnormally while liveness may still be true.",
      findEvidence(lines, [
        /timed out after \d+ms/u,
        /gateway timeout/u,
        /1006 abnormal closure/u,
        /gateway closed/u,
        /connect EPERM/u,
      ]),
    ),
  ];
  return causes.filter((cause): cause is AgentQualityCause => Boolean(cause));
}

function buildRunbook(causes: AgentQualityCause[]): AgentQualityRunbookSuggestion[] {
  const byId = new Map(causes.map((cause) => [cause.id, cause]));
  const suggestions: AgentQualityRunbookSuggestion[] = [];
  const add = (suggestion: AgentQualityRunbookSuggestion) => {
    if (byId.has(suggestion.id)) {
      suggestions.push(suggestion);
    }
  };
  add({
    id: "rpc_timeout_or_stall",
    title: "Separate liveness from readiness before restarting anything",
    steps: [
      "Run `openclaw gateway status --deep --require-rpc` to capture listener, pid, config, and RPC state.",
      "If liveness passes but RPC/readiness fails, inspect event-loop and memory warnings before restarting.",
      "Use `openclaw channels status --timeout 3000` as the delivery-readiness smoke after any fix.",
    ],
  });
  add({
    id: "duplicate_telegram_poller",
    title: "Find and stop duplicate Telegram pollers",
    steps: [
      "Search running processes for old gateway or Telegram poller instances that may share a bot token.",
      "Prefer stopping the stale poller over rotating tokens; token rotation hides the duplicate-owner bug.",
      "After cleanup, verify the log shows isolated ingress restart without a channel-exited event.",
    ],
  });
  add({
    id: "memory_pressure",
    title: "Reduce gateway memory pressure before blaming channel code",
    steps: [
      "Capture RSS/heap trend from recent gateway logs and note whether pressure rises every five minutes.",
      "Check recent plugin/session activity for large transcript or LCM operations.",
      "If pressure keeps rising, restart only after preserving the log window for leak analysis.",
    ],
  });
  add({
    id: "dist_artifact_missing",
    title: "Rebuild runtime artifacts before gateway restart",
    steps: [
      "Run `pnpm build` from the OpenClaw checkout and confirm `dist/telegram-ingress-worker.runtime.js` exists.",
      "Restart gateway only after the artifact exists, so launchd does not start a half-built dist.",
      "Keep the build/restart order in the incident note because this failure is time-window sensitive.",
    ],
  });
  add({
    id: "gateway_restart_window",
    title: "Treat recent restart windows as transient until proven persistent",
    steps: [
      "Correlate probe failures with stale gateway pid cleanup or LaunchAgent restart timestamps.",
      "Retry readiness after the startup grace window before escalating to auth/channel fixes.",
      "If restart loops continue, inspect service env and dist artifact state first.",
    ],
  });
  add({
    id: "provider_auth_error",
    title: "Repair credential source before retrying agent turns",
    steps: [
      "Identify the failing provider and agent from the auth error cluster; do not rotate unrelated keys.",
      "Prefer provider-native login/refresh for OAuth-backed providers instead of copying token material.",
      "Run a real agent smoke after repair and record the provider/model that actually won.",
    ],
  });
  return suggestions;
}

function parseSinceMinutes(value: AgentQualityOptions["sinceMinutes"]): number {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_SINCE_MINUTES;
  }
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SINCE_MINUTES;
}

async function runWithTimeout<T>(params: {
  name: string;
  timeoutMs: number;
  run: () => Promise<T>;
}): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      params.run(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${params.name} timed out after ${params.timeoutMs}ms`));
        }, params.timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function runChecked(
  id: string,
  name: string,
  run: () => Promise<AgentQualityCheck>,
  timeoutMs?: number,
): Promise<AgentQualityCheck> {
  try {
    return await (timeoutMs ? runWithTimeout({ name, timeoutMs, run }) : run());
  } catch (err) {
    return {
      id,
      name,
      status: "fail",
      summary: formatErrorMessage(err),
    };
  }
}

function getGatewayWarnings(record: Record<string, unknown>): {
  warnings: unknown[];
  warningDetails: string[];
  unreachableGatewayWarning: unknown;
} {
  const warnings = Array.isArray(record.warnings) ? record.warnings : [];
  const warningDetails = warnings
    .map((warning) => {
      const warningRecord = asRecord(warning);
      return typeof warningRecord?.message === "string"
        ? warningRecord.message
        : JSON.stringify(warning);
    })
    .slice(0, 5);
  const unreachableGatewayWarning = warnings.find((warning) => {
    const warningRecord = asRecord(warning);
    return warningRecord?.code === "no_gateway_reachable";
  });
  return { warnings, warningDetails, unreachableGatewayWarning };
}

function analyzeGatewayLiveness(payload: unknown): AgentQualityCheck {
  const record = asRecord(payload);
  if (!record) {
    return {
      id: "gateway-liveness",
      name: "Gateway Liveness",
      status: "fail",
      summary: "Gateway status did not return a structured payload.",
    };
  }
  const { warningDetails, unreachableGatewayWarning } = getGatewayWarnings(record);
  if (unreachableGatewayWarning) {
    const warningRecord = asRecord(unreachableGatewayWarning);
    return {
      id: "gateway-liveness",
      name: "Gateway Liveness",
      status: "fail",
      summary:
        typeof warningRecord?.message === "string"
          ? (warningRecord.message.split(".")[0] ?? warningRecord.message)
          : "No gateway answered the status probe.",
      details: warningDetails,
    };
  }
  const service = asRecord(record.service);
  const runtime = asRecord(service?.runtime);
  const port = asRecord(record.port);
  const listeners = asRecordArray(port?.listeners);
  const health = asRecord(record.health);
  const pid = typeof runtime?.pid === "number" ? ` pid=${runtime.pid}` : "";
  if (runtime?.status === "running" || listeners.length > 0 || health?.healthy === true) {
    return {
      id: "gateway-liveness",
      name: "Gateway Liveness",
      status: "pass",
      summary: `Gateway process/listener is alive${pid}.`,
    };
  }
  return {
    id: "gateway-liveness",
    name: "Gateway Liveness",
    status: "fail",
    summary: "Gateway process/listener is not confirmed alive.",
    details: warningDetails,
  };
}

function analyzeGatewayReadiness(payload: unknown): AgentQualityCheck {
  const record = asRecord(payload);
  if (!record) {
    return {
      id: "gateway-readiness",
      name: "Gateway RPC Readiness",
      status: "fail",
      summary: "Gateway status did not return a structured payload.",
    };
  }
  const { warnings, warningDetails, unreachableGatewayWarning } = getGatewayWarnings(record);
  if (unreachableGatewayWarning) {
    const warningRecord = asRecord(unreachableGatewayWarning);
    return {
      id: "gateway-readiness",
      name: "Gateway RPC Readiness",
      status: "fail",
      summary:
        typeof warningRecord?.message === "string"
          ? (warningRecord.message.split(".")[0] ?? warningRecord.message)
          : "No gateway answered the RPC readiness probe.",
      details: warningDetails,
    };
  }
  const rpc = asRecord(record.rpc);
  if (rpc?.ok === false) {
    return {
      id: "gateway-readiness",
      name: "Gateway RPC Readiness",
      status: "fail",
      summary: typeof rpc.error === "string" ? rpc.error : "Gateway RPC probe failed.",
    };
  }
  return {
    id: "gateway-readiness",
    name: "Gateway RPC Readiness",
    status: warnings.length > 0 ? "warn" : "pass",
    summary:
      warnings.length > 0
        ? `Gateway RPC reachable with ${warnings.length} warning(s).`
        : "Gateway RPC probe completed.",
    details: warningDetails,
  };
}

function analyzeHealth(payload: unknown): AgentQualityCheck {
  const record = asRecord(payload);
  if (record?.ok === false) {
    const error = asRecord(record.error);
    return {
      id: "health",
      name: "Runtime Health",
      status: "fail",
      summary:
        typeof error?.message === "string"
          ? error.message
          : typeof record.error === "string"
            ? record.error
            : "Gateway health command failed.",
    };
  }
  const eventLoop = asRecord(record?.eventLoop);
  const degraded = eventLoop?.degraded === true;
  const reasons = Array.isArray(eventLoop?.reasons)
    ? eventLoop.reasons.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (degraded) {
    return {
      id: "health",
      name: "Runtime Health",
      status: "warn",
      summary: "Gateway event loop is degraded.",
      details: reasons.length > 0 ? reasons : undefined,
    };
  }
  return {
    id: "health",
    name: "Runtime Health",
    status: "pass",
    summary: "Gateway health command completed.",
  };
}

function analyzeChannels(payload: unknown): AgentQualityCheck {
  const record = asRecord(payload);
  if (record?.gatewayReachable === false) {
    return {
      id: "telegram-channels",
      name: "Telegram Channels",
      status: "fail",
      summary:
        typeof record.error === "string"
          ? (record.error.split("\n")[0] ?? record.error)
          : "Gateway is not reachable for channel status.",
    };
  }
  const accountsByChannel = asRecord(record?.channelAccounts);
  if (!accountsByChannel) {
    return {
      id: "telegram-channels",
      name: "Telegram Channels",
      status: "fail",
      summary: "Channel status payload did not include channelAccounts.",
    };
  }

  const failures: string[] = [];
  let enabled = 0;
  let connected = 0;
  let disabled = 0;

  for (const [channelId, rawAccounts] of Object.entries(accountsByChannel)) {
    for (const account of asRecordArray(rawAccounts)) {
      const accountId = typeof account.accountId === "string" ? account.accountId : "default";
      const label = `${channelId}:${accountId}`;
      if (account.enabled === false) {
        disabled += 1;
        continue;
      }
      if (account.configured === false) {
        continue;
      }
      enabled += 1;
      if (account.running === false) {
        failures.push(`${label} is enabled but stopped.`);
      }
      if (account.connected === false) {
        failures.push(`${label} is enabled but disconnected.`);
      } else {
        connected += 1;
      }
      if (
        typeof account.lastError === "string" &&
        account.lastError &&
        account.lastError !== "disabled"
      ) {
        failures.push(`${label} lastError=${account.lastError}`);
      }
    }
  }

  return {
    id: "telegram-channels",
    name: "Telegram Channels",
    status: failures.length > 0 ? "fail" : "pass",
    summary:
      failures.length > 0
        ? `${failures.length} enabled channel issue(s) found.`
        : `${connected}/${enabled} enabled channel account(s) connected; ${disabled} disabled.`,
    details: failures.slice(0, 10),
  };
}

function parseLogTimestamp(line: string): number | null {
  try {
    const parsed = JSON.parse(line) as { time?: unknown };
    if (typeof parsed.time !== "string") {
      return null;
    }
    const value = Date.parse(parsed.time);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function tailLines(text: string, limit: number): string[] {
  const lines = text.split(/\r?\n/u).filter(Boolean);
  return lines.slice(Math.max(0, lines.length - limit));
}

function extractLogMessage(line: string): string {
  try {
    const parsed = JSON.parse(line) as { message?: unknown; msg?: unknown; time?: unknown };
    if (typeof parsed.message === "string") {
      return typeof parsed.time === "string" ? `${parsed.time} ${parsed.message}` : parsed.message;
    }
    if (typeof parsed.msg === "string") {
      return typeof parsed.time === "string" ? `${parsed.time} ${parsed.msg}` : parsed.msg;
    }
  } catch {
    // Non-JSON logs are already human-readable enough for the gate.
  }
  return line;
}

function uniqueLogDetails(lines: string[], limit: number): string[] {
  const seen = new Set<string>();
  const details: string[] = [];
  for (const line of lines) {
    const key = line.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/u, "");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    details.push(line);
    if (details.length >= limit) {
      break;
    }
  }
  return details;
}

function extractMissingDistModulePath(message: string): string | null {
  const match = /Cannot find module ['"]([^'"]*\/dist\/[^'"]+)['"]/u.exec(message);
  return match?.[1] ?? null;
}

function addArtifactReference(
  references: Map<string, string[]>,
  filePath: string | null,
  message: string,
): void {
  if (!filePath) {
    return;
  }
  const evidence = references.get(filePath) ?? [];
  evidence.push(message);
  references.set(filePath, evidence);
}

function scanGatewayLog(params: { text: string; sinceMs: number; nowMs: number }): {
  failures: string[];
  warnings: string[];
  artifactReferences: Map<string, string[]>;
  historicalArtifactReferences: Map<string, string[]>;
  scanned: number;
} {
  const cutoff = params.nowMs - params.sinceMs;
  const failures: string[] = [];
  const warnings: string[] = [];
  const artifactReferences = new Map<string, string[]>();
  const historicalArtifactReferences = new Map<string, string[]>();
  let scanned = 0;

  for (const line of tailLines(params.text, LOG_SCAN_MAX_LINES)) {
    const timestamp = parseLogTimestamp(line);
    const message = extractLogMessage(line);
    if (message.includes("Agent Quality Gate:")) {
      continue;
    }
    if (timestamp !== null && timestamp < cutoff) {
      addArtifactReference(
        historicalArtifactReferences,
        extractMissingDistModulePath(message),
        message,
      );
      continue;
    }
    scanned += 1;
    addArtifactReference(artifactReferences, extractMissingDistModulePath(message), message);
    if (/\bchannel exited:/u.test(message)) {
      failures.push(message);
      continue;
    }
    if (/\bACP_(?:SESSION_INIT_FAILED|TURN_FAILED)\b/u.test(message)) {
      failures.push(message);
      continue;
    }
    if (/Cannot find module .*\/dist\//u.test(message)) {
      failures.push(message);
      continue;
    }
    if (
      /Missing API key/iu.test(message) ||
      /(?:HTTP|status|code|errorCode|response)[^\n]{0,40}\b401\b/iu.test(message) ||
      /\b401 Unauthorized\b/iu.test(message) ||
      /Invalid authentication credentials/iu.test(message)
    ) {
      failures.push(message);
      continue;
    }
    if (/isolated polling cycle error reason=getUpdates conflict/u.test(message)) {
      warnings.push(message);
      continue;
    }
    if (/memory pressure: level=warning/u.test(message)) {
      warnings.push(message);
    }
  }
  return {
    failures,
    warnings,
    artifactReferences,
    historicalArtifactReferences,
    scanned,
  };
}

async function classifyArtifactIntegrity(params: {
  deps: AgentQualityDeps;
  artifactReferences: Map<string, string[]>;
  historicalArtifactReferences: Map<string, string[]>;
}): Promise<ArtifactIntegrityFinding[]> {
  const pathExists =
    params.deps.pathExists ??
    (async (filePath: string) => {
      try {
        await stat(filePath);
        return true;
      } catch {
        return false;
      }
    });
  const findings: ArtifactIntegrityFinding[] = [];
  for (const [filePath, evidence] of params.artifactReferences) {
    findings.push({
      filePath,
      state: (await pathExists(filePath)) ? "stale_reference" : "missing_now",
      evidence: uniqueLogDetails(evidence, 3),
    });
  }
  for (const [filePath, evidence] of params.historicalArtifactReferences) {
    if (params.artifactReferences.has(filePath)) {
      continue;
    }
    findings.push({
      filePath,
      state: "historical",
      evidence: uniqueLogDetails(evidence, 3),
    });
  }
  return findings.toSorted((left, right) => {
    const leftRank = left.state === "missing_now" ? 0 : left.state === "stale_reference" ? 1 : 2;
    const rightRank = right.state === "missing_now" ? 0 : right.state === "stale_reference" ? 1 : 2;
    return leftRank - rightRank || left.filePath.localeCompare(right.filePath);
  });
}

function formatArtifactFinding(finding: ArtifactIntegrityFinding): string {
  return `${finding.state}: ${finding.filePath}`;
}

function artifactFailureSet(findings: ArtifactIntegrityFinding[]): Set<string> {
  return new Set(
    findings
      .filter((finding) => finding.state === "stale_reference")
      .flatMap((finding) => finding.evidence),
  );
}

function buildArtifactIntegrityCheck(
  findings: ArtifactIntegrityFinding[],
  sinceMinutes: number,
): AgentQualityCheck {
  const missingNow = findings.filter((finding) => finding.state === "missing_now");
  const staleReferences = findings.filter((finding) => finding.state === "stale_reference");
  if (missingNow.length > 0) {
    return {
      id: "artifact-integrity",
      name: "Artifact Integrity",
      status: "fail",
      summary: `${missingNow.length} runtime artifact reference(s) still missing.`,
      details: findings.slice(0, 8).map(formatArtifactFinding),
    };
  }
  if (staleReferences.length > 0) {
    return {
      id: "artifact-integrity",
      name: "Artifact Integrity",
      status: "warn",
      summary: `${staleReferences.length} missing artifact reference(s) are resolved but recent.`,
      details: findings.slice(0, 8).map(formatArtifactFinding),
    };
  }
  const historical = findings.filter((finding) => finding.state === "historical");
  if (historical.length > 0) {
    return {
      id: "artifact-integrity",
      name: "Artifact Integrity",
      status: "pass",
      summary: `${historical.length} historical missing artifact reference(s) ignored outside the active window.`,
      details: historical.slice(0, 8).map(formatArtifactFinding),
    };
  }
  return {
    id: "artifact-integrity",
    name: "Artifact Integrity",
    status: "pass",
    summary: `No missing dist artifact references in the last ${sinceMinutes} minute(s).`,
  };
}

async function analyzeLogs(params: {
  deps: AgentQualityDeps;
  sinceMinutes: number;
  now: Date;
}): Promise<{
  check: AgentQualityCheck;
  artifactCheck: AgentQualityCheck;
  logFile: string | null;
}> {
  const findLatestLogFile = params.deps.findLatestLogFile ?? defaultFindLatestLogFile;
  const logFile = await findLatestLogFile();
  if (!logFile) {
    return {
      logFile: null,
      check: {
        id: "gateway-log",
        name: "Gateway Log Sentinel",
        status: "warn",
        summary: "No OpenClaw gateway log file found.",
      },
      artifactCheck: {
        id: "artifact-integrity",
        name: "Artifact Integrity",
        status: "warn",
        summary: "No OpenClaw gateway log file found.",
      },
    };
  }

  const text = params.deps.readTextFile
    ? await params.deps.readTextFile(logFile)
    : await readFile(logFile, "utf8");
  const scan = scanGatewayLog({
    text,
    sinceMs: params.sinceMinutes * 60_000,
    nowMs: params.now.getTime(),
  });
  const artifactFindings = await classifyArtifactIntegrity({
    deps: params.deps,
    artifactReferences: scan.artifactReferences,
    historicalArtifactReferences: scan.historicalArtifactReferences,
  });
  const staleArtifactFailures = artifactFailureSet(artifactFindings);
  const activeFailures = scan.failures.filter((failure) => !staleArtifactFailures.has(failure));
  const staleWarnings = scan.failures.filter((failure) => staleArtifactFailures.has(failure));
  const warnings = [...scan.warnings, ...staleWarnings];
  const artifactCheck = buildArtifactIntegrityCheck(artifactFindings, params.sinceMinutes);
  if (activeFailures.length > 0) {
    return {
      logFile,
      artifactCheck,
      check: {
        id: "gateway-log",
        name: "Gateway Log Sentinel",
        status: "fail",
        summary: `${activeFailures.length} recent active fatal gateway/channel log event(s).`,
        details: uniqueLogDetails(activeFailures, 8),
      },
    };
  }
  if (warnings.length > 0) {
    return {
      logFile,
      artifactCheck,
      check: {
        id: "gateway-log",
        name: "Gateway Log Sentinel",
        status: "warn",
        summary: `${warnings.length} recent recoverable/resolved log event(s).`,
        details: uniqueLogDetails(warnings, 8),
      },
    };
  }
  return {
    logFile,
    artifactCheck,
    check: {
      id: "gateway-log",
      name: "Gateway Log Sentinel",
      status: "pass",
      summary: `No fatal channel or ACP events in the last ${params.sinceMinutes} minute(s).`,
    },
  };
}

async function analyzeRegressionCoverage(params: {
  deps: AgentQualityDeps;
  repoRoot: string;
}): Promise<AgentQualityCheck> {
  const pathExists =
    params.deps.pathExists ??
    (async (filePath: string) => {
      try {
        await stat(filePath);
        return true;
      } catch {
        return false;
      }
    });
  const required = [
    "src/auto-reply/reply/dispatch-acp.test.ts",
    "src/auto-reply/reply/dispatch-acp-command-bypass.test.ts",
    "src/auto-reply/reply/dispatch-from-config.test.ts",
    "src/auto-reply/reply/commands-acp.test.ts",
    "extensions/telegram/src/bot-message-dispatch.test.ts",
    "extensions/telegram/src/command-targeting.test.ts",
    "extensions/telegram/src/polling-session.test.ts",
  ];
  const missing: string[] = [];
  for (const relative of required) {
    if (!(await pathExists(path.join(params.repoRoot, relative)))) {
      missing.push(relative);
    }
  }
  return {
    id: "regression-coverage",
    name: "Regression Coverage",
    status: missing.length > 0 ? "warn" : "pass",
    summary:
      missing.length > 0
        ? `${missing.length} expected regression test file(s) missing.`
        : "ACP and Telegram routing regression files are present.",
    details: missing,
  };
}

function parseEnvLine(line: string, name: string): string | null {
  let trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  if (trimmed.startsWith("export ")) {
    trimmed = trimmed.slice("export ".length).trim();
  }
  if (!trimmed.startsWith(`${name}=`)) {
    return null;
  }
  const value = trimmed
    .split("=", 2)[1]
    ?.trim()
    .replace(/^['"]|['"]$/gu, "");
  return value ? "<redacted>" : null;
}

async function hasEnvFileValue(
  names: string[],
  deps: AgentQualityDeps,
): Promise<{ present: boolean; source?: string }> {
  for (const name of names) {
    if (process.env[name]) {
      return { present: true, source: `process env:${name}` };
    }
  }
  for (const envFile of ENV_FILES) {
    let text = "";
    try {
      text = deps.readTextFile ? await deps.readTextFile(envFile) : await readFile(envFile, "utf8");
    } catch {
      continue;
    }
    for (const name of names) {
      if (text.split(/\r?\n/u).some((line) => parseEnvLine(line, name))) {
        return { present: true, source: `${envFile}:${name}` };
      }
    }
  }
  return { present: false };
}

async function analyzeEnvironmentDoctor(params: {
  deps: AgentQualityDeps;
  repoRoot: string;
}): Promise<AgentQualityCheck> {
  const checks = [
    { label: "Gemini", names: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
    { label: "xAI/Grok", names: ["XAI_API_KEY", "GROK_API_KEY", "X_AI_API_KEY"] },
  ];
  const missing: string[] = [];
  const present: string[] = [];
  for (const check of checks) {
    const result = await hasEnvFileValue(check.names, params.deps);
    if (result.present) {
      present.push(`${check.label} source=${result.source}`);
    } else {
      missing.push(`${check.label} key source missing (${check.names.join("/")})`);
    }
  }
  const telegramWorker = path.join(params.repoRoot, "dist/telegram-ingress-worker.runtime.js");
  const pathExists =
    params.deps.pathExists ??
    (async (filePath: string) => {
      try {
        await stat(filePath);
        return true;
      } catch {
        return false;
      }
    });
  if (!(await pathExists(telegramWorker))) {
    missing.push("dist/telegram-ingress-worker.runtime.js missing");
  } else {
    present.push("telegram ingress runtime artifact present");
  }
  return {
    id: "environment-doctor",
    name: "Environment Doctor",
    status: missing.length > 0 ? "warn" : "pass",
    summary:
      missing.length > 0
        ? `${missing.length} environment/artifact drift item(s) found.`
        : "Provider key sources and runtime artifacts are present.",
    details: missing.length > 0 ? [...missing, ...present].slice(0, 8) : present.slice(0, 4),
  };
}

export async function runAgentQualityGate(
  opts: AgentQualityOptions = {},
  deps: AgentQualityDeps = {},
): Promise<AgentQualityReport> {
  const now = deps.now?.() ?? new Date();
  const sinceMinutes = parseSinceMinutes(opts.sinceMinutes);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const repoRoot = opts.repoRoot ?? resolveDefaultRepoRoot();
  const checks: AgentQualityCheck[] = [];

  const gatewayStatusPromise = runWithTimeout({
    name: "Gateway status probe",
    timeoutMs,
    run: () =>
      deps.getGatewayStatus ? deps.getGatewayStatus() : defaultGetGatewayStatus(timeoutMs),
  }).catch((err) => err);
  const healthCheckPromise = runChecked(
    "health",
    "Runtime Health",
    async () =>
      analyzeHealth(deps.getHealth ? await deps.getHealth() : await defaultGetHealth(timeoutMs)),
    timeoutMs,
  );
  const channelsCheckPromise = runChecked(
    "telegram-channels",
    "Telegram Delivery Readiness",
    async () =>
      analyzeChannels(
        deps.getChannelsStatus
          ? await deps.getChannelsStatus()
          : await defaultGetChannelsStatus(timeoutMs),
      ),
    timeoutMs,
  );

  const [gatewayStatus, healthCheck, channelsCheck] = await Promise.all([
    gatewayStatusPromise,
    healthCheckPromise,
    channelsCheckPromise,
  ]);

  if (gatewayStatus instanceof Error) {
    checks.push(
      {
        id: "gateway-liveness",
        name: "Gateway Liveness",
        status: "fail",
        summary: gatewayStatus.message,
      },
      {
        id: "gateway-readiness",
        name: "Gateway RPC Readiness",
        status: "fail",
        summary: gatewayStatus.message,
      },
    );
  } else {
    checks.push(
      asRecord(gatewayStatus) || !isPromiseLike(gatewayStatus)
        ? analyzeGatewayLiveness(gatewayStatus)
        : {
            id: "gateway-liveness",
            name: "Gateway Liveness",
            status: "fail",
            summary: "Gateway status probe did not complete.",
          },
    );
    checks.push(analyzeGatewayReadiness(gatewayStatus));
  }
  checks.push(healthCheck, { ...channelsCheck, name: "Telegram Delivery Readiness" });
  let logFile: string | null = null;
  if (opts.logs !== false) {
    const logResult = await analyzeLogs({ deps, sinceMinutes, now });
    logFile = logResult.logFile;
    checks.push(logResult.check);
    checks.push(logResult.artifactCheck);
  }
  checks.push(
    await runChecked(
      "environment-doctor",
      "Environment Doctor",
      async () => analyzeEnvironmentDoctor({ deps, repoRoot }),
      timeoutMs,
    ),
  );
  checks.push(await analyzeRegressionCoverage({ deps, repoRoot }));

  const likelyCauses = classifyLikelyCauses(checks);
  return {
    generatedAt: now.toISOString(),
    overall: resolveOverall(checks),
    checks,
    likelyCauses,
    runbook: buildRunbook(likelyCauses),
    logFile,
    summary: summarizeOverall(checks),
  };
}

function formatStatus(status: AgentQualityStatus): string {
  return status.toUpperCase();
}

export function formatAgentQualityReport(report: AgentQualityReport): string {
  const lines = [`Agent Quality Gate: ${formatStatus(report.overall)}`, ""];
  for (const check of report.checks) {
    lines.push(`${check.name}: ${formatStatus(check.status)} - ${check.summary}`);
  }
  if (report.likelyCauses.length > 0) {
    lines.push("", "Likely Causes:");
    for (const cause of report.likelyCauses.slice(0, 8)) {
      lines.push(`- ${cause.id}: ${formatStatus(cause.status)} - ${cause.summary}`);
      for (const evidence of cause.evidence.slice(0, 2)) {
        lines.push(`  evidence: ${evidence}`);
      }
    }
  }
  if (report.runbook.length > 0) {
    lines.push("", "Suggested Runbook:");
    for (const item of report.runbook.slice(0, 5)) {
      lines.push(`- ${item.title}`);
      for (const step of item.steps.slice(0, 3)) {
        lines.push(`  - ${step}`);
      }
    }
  }
  const failures = report.checks.flatMap((check) =>
    check.status === "fail" && check.details?.length
      ? check.details.map((detail) => `${check.name}: ${detail}`)
      : [],
  );
  const warnings = report.checks.flatMap((check) =>
    check.status === "warn" && check.details?.length
      ? check.details.map((detail) => `${check.name}: ${detail}`)
      : [],
  );
  if (failures.length > 0) {
    lines.push("", "Failures:");
    for (const failure of failures.slice(0, 10)) {
      lines.push(`- ${failure}`);
    }
  }
  if (warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of warnings.slice(0, 10)) {
      lines.push(`- ${warning}`);
    }
  }
  if (report.logFile) {
    lines.push("", `Log file: ${report.logFile}`);
  }
  return lines.join("\n");
}

export async function agentQualityCheckCommand(
  opts: AgentQualityOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const report = await runAgentQualityGate(opts);
  if (opts.json) {
    writeRuntimeJson(runtime, report);
  } else {
    runtime.log(formatAgentQualityReport(report));
  }
  if (report.overall === "fail") {
    runtime.exit(1);
  }
}
