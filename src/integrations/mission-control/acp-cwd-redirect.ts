import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_MC_CHECKOUT =
  process.env.MC_DEFAULT_CHECKOUT?.trim() || "/Users/lianglin/Projects/mission-control";

export type McAcpCwdRedirectInput = {
  requestedCwd?: string;
  label?: string;
  conversationId?: string;
  threadId?: string;
  sessionKey?: string;
  mcRepo?: string;
};

export type McAcpCwdRedirectResult = {
  cwd?: string;
  redirected: boolean;
  requestedCwd?: string;
  bindingKey?: string;
  reason?: string;
  error?: string;
};

type ResolveScriptPayload = {
  redirected?: boolean;
  cwd?: string;
  bindingKey?: string;
  reason?: string;
};

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveMcAcpSpawnCwd(
  input: McAcpCwdRedirectInput,
): Promise<McAcpCwdRedirectResult> {
  const requested = normalizeOptionalString(input.requestedCwd);
  if (!requested) {
    return { redirected: false, cwd: undefined };
  }

  const mcRepo = normalizeOptionalString(input.mcRepo) ?? DEFAULT_MC_CHECKOUT;
  const defaultCheckout = path.resolve(mcRepo);
  const requestedResolved = path.resolve(requested);

  if (requestedResolved !== defaultCheckout) {
    return { redirected: false, cwd: requested, requestedCwd: requested };
  }

  const scriptPath = path.join(mcRepo, "scripts/acp-mc-resolve-cwd.sh");
  if (!(await pathExists(scriptPath))) {
    return {
      redirected: false,
      cwd: requested,
      requestedCwd: requested,
      reason: "script_missing",
      error: `MC ACP redirect script not found: ${scriptPath}`,
    };
  }

  const args = ["--requested-cwd", requested, "--json"];
  const label = normalizeOptionalString(input.label);
  if (label) {
    args.push("--label", label);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MC_REPO: mcRepo,
  };
  if (input.conversationId) {
    env.MC_TELEGRAM_CHAT_ID = input.conversationId;
  }
  if (input.threadId) {
    env.MC_TELEGRAM_THREAD_ID = input.threadId;
  }
  if (input.sessionKey) {
    env.MC_ACP_SESSION_KEY = input.sessionKey;
  }

  try {
    const { stdout } = await execFileAsync("bash", [scriptPath, ...args], {
      env,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout.trim()) as ResolveScriptPayload;
    return {
      redirected: Boolean(parsed.redirected),
      cwd: parsed.cwd ?? requested,
      requestedCwd: requested,
      bindingKey: parsed.bindingKey,
      reason: parsed.reason,
    };
  } catch (err) {
    return {
      redirected: false,
      cwd: requested,
      requestedCwd: requested,
      reason: "script_failed",
      error: formatErrorMessage(err),
    };
  }
}
