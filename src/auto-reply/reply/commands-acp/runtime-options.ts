import { getAcpSessionManager } from "../../../acp/control-plane/manager.js";
import {
  parseRuntimeTimeoutSecondsInput,
  validateRuntimeConfigOptionInput,
  validateRuntimeCwdInput,
  validateRuntimeModeInput,
  validateRuntimeModelInput,
  validateRuntimePermissionProfileInput,
} from "../../../acp/control-plane/runtime-options.js";
import { resolveAcpSessionIdentifierLinesFromIdentity } from "../../../acp/runtime/session-identifiers.js";
import { normalizeLowercaseStringOrEmpty } from "../../../shared/string-coerce.js";
import { findLatestTaskForRelatedSessionKeyForOwner } from "../../../tasks/task-owner-access.js";
import { sanitizeTaskStatusText } from "../../../tasks/task-status.js";
import type { CommandHandlerResult, HandleCommandsParams } from "../commands-types.js";
import {
  ACP_CWD_USAGE,
  ACP_MODEL_USAGE,
  ACP_PERMISSIONS_USAGE,
  ACP_RESET_OPTIONS_USAGE,
  ACP_SET_MODE_USAGE,
  ACP_STATUS_USAGE,
  ACP_TIMEOUT_USAGE,
  formatRuntimeOptionsText,
  parseOptionalSingleTarget,
  parseSetCommandInput,
  parseSingleValueCommandInput,
  stopWithText,
  withAcpCommandErrorBoundary,
} from "./shared.js";
import { resolveAcpTargetSessionKey } from "./targets.js";

async function resolveTargetSessionKeyOrStop(params: {
  commandParams: HandleCommandsParams;
  token: string | undefined;
}): Promise<string | CommandHandlerResult> {
  const target = await resolveAcpTargetSessionKey({
    commandParams: params.commandParams,
    token: params.token,
  });
  if (!target.ok) {
    return stopWithText(`⚠️ ${target.error}`);
  }
  return target.sessionKey;
}

async function resolveOptionalSingleTargetOrStop(params: {
  commandParams: HandleCommandsParams;
  restTokens: string[];
  usage: string;
}): Promise<string | CommandHandlerResult> {
  const parsed = parseOptionalSingleTarget(params.restTokens, params.usage);
  if (!parsed.ok) {
    return stopWithText(`⚠️ ${parsed.error}`);
  }
  return await resolveTargetSessionKeyOrStop({
    commandParams: params.commandParams,
    token: parsed.sessionToken,
  });
}

type SingleTargetValue = {
  targetSessionKey: string;
  value: string;
};

async function resolveSingleTargetValueOrStop(params: {
  commandParams: HandleCommandsParams;
  restTokens: string[];
  usage: string;
}): Promise<SingleTargetValue | CommandHandlerResult> {
  const parsed = parseSingleValueCommandInput(params.restTokens, params.usage);
  if (!parsed.ok) {
    return stopWithText(`⚠️ ${parsed.error}`);
  }
  const targetSessionKey = await resolveTargetSessionKeyOrStop({
    commandParams: params.commandParams,
    token: parsed.value.sessionToken,
  });
  if (typeof targetSessionKey !== "string") {
    return targetSessionKey;
  }
  return {
    targetSessionKey,
    value: parsed.value.value,
  };
}

async function withSingleTargetValue<T>(params: {
  commandParams: HandleCommandsParams;
  restTokens: string[];
  usage: string;
  run: (resolved: SingleTargetValue) => Promise<T | CommandHandlerResult>;
}): Promise<T | CommandHandlerResult> {
  const resolved = await resolveSingleTargetValueOrStop({
    commandParams: params.commandParams,
    restTokens: params.restTokens,
    usage: params.usage,
  });
  if (!("targetSessionKey" in resolved)) {
    return resolved;
  }
  return await params.run(resolved);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatShortSessionKey(sessionKey: string): string {
  const id = sessionKey.split(":").pop() ?? sessionKey;
  if (id.length <= 16) {
    return id;
  }
  return `${id.slice(0, 8)}...${id.slice(-4)}`;
}

function formatTimestamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace("T", " ");
}

function getStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function getConfigOptionValue(details: unknown, id: string): string | undefined {
  if (!isRecord(details) || !Array.isArray(details.configOptions)) {
    return undefined;
  }
  for (const option of details.configOptions) {
    if (!isRecord(option) || option.id !== id) {
      continue;
    }
    const currentValue = option.currentValue;
    if (typeof currentValue === "string" && currentValue.trim()) {
      return currentValue.trim();
    }
  }
  return undefined;
}

function getRuntimePid(params: { details: unknown; summary: unknown }): string | undefined {
  if (isRecord(params.details)) {
    const pid = params.details.pid;
    if (typeof pid === "number" || typeof pid === "string") {
      const text = String(pid).trim();
      if (text) {
        return text;
      }
    }
  }
  if (typeof params.summary === "string") {
    const match = params.summary.match(/\bpid=(\d+)\b/);
    return match?.[1];
  }
  return undefined;
}

function getRuntimeOpenState(params: { details: unknown; summary: unknown }): string | undefined {
  if (isRecord(params.details) && typeof params.details.closed === "boolean") {
    return params.details.closed ? "closed" : "open";
  }
  if (typeof params.summary === "string") {
    if (/\bclosed\b/i.test(params.summary)) {
      return "closed";
    }
    if (/\bopen\b/i.test(params.summary) || /\balive\b/i.test(params.summary)) {
      return "open";
    }
  }
  if (isRecord(params.details) && params.details.status === "alive") {
    return "open";
  }
  return undefined;
}

function formatRuntimeLine(params: { details: unknown; summary: unknown }): string | undefined {
  const openState = getRuntimeOpenState(params);
  const pid = getRuntimePid(params);
  if (!openState && !pid) {
    return undefined;
  }
  return `Runtime: ${openState ?? "unknown"}${pid ? ` (pid ${pid})` : ""}`;
}

function formatStateLine(state: unknown, runtimeDetails: unknown, runtimeSummary: unknown): string {
  const stateText = typeof state === "string" && state.trim() ? state.trim() : "unknown";
  const openState = getRuntimeOpenState({ details: runtimeDetails, summary: runtimeSummary });
  if (openState === "closed") {
    return "Status: closed";
  }
  if (stateText === "idle") {
    return "Status: idle (ready)";
  }
  return `Status: ${stateText}`;
}

export async function handleAcpStatusAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const targetSessionKey = await resolveOptionalSingleTargetOrStop({
    commandParams: params,
    restTokens,
    usage: ACP_STATUS_USAGE,
  });
  if (typeof targetSessionKey !== "string") {
    return targetSessionKey;
  }

  return await withAcpCommandErrorBoundary({
    run: async () =>
      await getAcpSessionManager().getSessionStatus({
        cfg: params.cfg,
        sessionKey: targetSessionKey,
      }),
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not read ACP session status.",
    onSuccess: (status) => {
      const linkedTask = findLatestTaskForRelatedSessionKeyForOwner({
        relatedSessionKey: status.sessionKey,
        callerOwnerKey: params.sessionKey,
      });
      const sessionIdentifierLines = resolveAcpSessionIdentifierLinesFromIdentity({
        backend: status.backend,
        identity: status.identity,
      });
      const taskProgress = sanitizeTaskStatusText(linkedTask?.progressSummary);
      const taskSummary = sanitizeTaskStatusText(linkedTask?.terminalSummary, {
        errorContext: true,
      });
      const taskError = sanitizeTaskStatusText(linkedTask?.error, { errorContext: true });
      const lastError = sanitizeTaskStatusText(status.lastError, { errorContext: true });
      const runtimeSummary = status.runtimeStatus?.summary;
      const runtimeDetails = status.runtimeStatus?.details;
      const model =
        getStringField(status.runtimeOptions, "model") ??
        getConfigOptionValue(runtimeDetails, "model");
      const thinking =
        getStringField(status.runtimeOptions, "thinking") ??
        getStringField(status.runtimeOptions, "effort") ??
        getConfigOptionValue(runtimeDetails, "effort");
      const cwd =
        getStringField(status.runtimeOptions, "cwd") ?? getStringField(runtimeDetails, "cwd");
      const runtimeLine = formatRuntimeLine({
        details: runtimeDetails,
        summary: runtimeSummary,
      });
      const lines = [
        "ACP status:",
        "-----",
        formatStateLine(status.state, runtimeDetails, runtimeSummary),
        `Agent: ${status.agent} via ${status.backend}`,
        ...(model ? [`Model: ${model}`] : []),
        ...(thinking ? [`Thinking: ${thinking}`] : []),
        ...(cwd ? [`Cwd: ${cwd}`] : []),
        `Mode: ${status.mode}`,
        ...(runtimeLine ? [runtimeLine] : []),
        `Last active: ${formatTimestamp(status.lastActivityAt)}`,
        `Session: ${formatShortSessionKey(status.sessionKey)}`,
        ...(linkedTask
          ? [
              `Task: ${linkedTask.status}${
                linkedTask.deliveryStatus ? ` (${linkedTask.deliveryStatus})` : ""
              }`,
              ...(taskProgress ? [`Progress: ${taskProgress}`] : []),
              ...(taskSummary ? [`Summary: ${taskSummary}`] : []),
              ...(taskError ? [`Task error: ${taskError}`] : []),
              ...(typeof linkedTask.lastEventAt === "number"
                ? [`Task updated: ${formatTimestamp(linkedTask.lastEventAt)}`]
                : []),
            ]
          : []),
        ...(lastError ? [`Last error: ${lastError}`] : []),
        "",
        "Manage: /acp close | /acp model <model> | /acp set thinking high",
      ];
      return stopWithText(lines.join("\n"));
    },
  });
}

export async function handleAcpSetModeAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  return await withSingleTargetValue({
    commandParams: params,
    restTokens,
    usage: ACP_SET_MODE_USAGE,
    run: async ({ targetSessionKey, value }) =>
      await withAcpCommandErrorBoundary({
        run: async () => {
          const runtimeMode = validateRuntimeModeInput(value);
          const options = await getAcpSessionManager().setSessionRuntimeMode({
            cfg: params.cfg,
            sessionKey: targetSessionKey,
            runtimeMode,
          });
          return {
            runtimeMode,
            options,
          };
        },
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "Could not update ACP runtime mode.",
        onSuccess: ({ runtimeMode, options }) =>
          stopWithText(
            `✅ Updated ACP runtime mode for ${targetSessionKey}: ${runtimeMode}. Effective options: ${formatRuntimeOptionsText(options)}`,
          ),
      }),
  });
}

export async function handleAcpSetAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const parsed = parseSetCommandInput(restTokens);
  if (!parsed.ok) {
    return stopWithText(`⚠️ ${parsed.error}`);
  }
  const target = await resolveAcpTargetSessionKey({
    commandParams: params,
    token: parsed.value.sessionToken,
  });
  if (!target.ok) {
    return stopWithText(`⚠️ ${target.error}`);
  }
  const key = parsed.value.key.trim();
  const value = parsed.value.value.trim();

  return await withAcpCommandErrorBoundary({
    run: async () => {
      const lowerKey = normalizeLowercaseStringOrEmpty(key);
      if (lowerKey === "cwd") {
        const cwd = validateRuntimeCwdInput(value);
        const options = await getAcpSessionManager().updateSessionRuntimeOptions({
          cfg: params.cfg,
          sessionKey: target.sessionKey,
          patch: { cwd },
        });
        return {
          text: `✅ Updated ACP cwd for ${target.sessionKey}: ${cwd}. Effective options: ${formatRuntimeOptionsText(options)}`,
        };
      }
      const validated = validateRuntimeConfigOptionInput(key, value);
      const options = await getAcpSessionManager().setSessionConfigOption({
        cfg: params.cfg,
        sessionKey: target.sessionKey,
        key: validated.key,
        value: validated.value,
      });
      return {
        text: `✅ Updated ACP config option for ${target.sessionKey}: ${validated.key}=${validated.value}. Effective options: ${formatRuntimeOptionsText(options)}`,
      };
    },
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not update ACP config option.",
    onSuccess: ({ text }) => stopWithText(text),
  });
}

export async function handleAcpCwdAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  return await withSingleTargetValue({
    commandParams: params,
    restTokens,
    usage: ACP_CWD_USAGE,
    run: async ({ targetSessionKey, value }) =>
      await withAcpCommandErrorBoundary({
        run: async () => {
          const cwd = validateRuntimeCwdInput(value);
          const options = await getAcpSessionManager().updateSessionRuntimeOptions({
            cfg: params.cfg,
            sessionKey: targetSessionKey,
            patch: { cwd },
          });
          return {
            cwd,
            options,
          };
        },
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "Could not update ACP cwd.",
        onSuccess: ({ cwd, options }) =>
          stopWithText(
            `✅ Updated ACP cwd for ${targetSessionKey}: ${cwd}. Effective options: ${formatRuntimeOptionsText(options)}`,
          ),
      }),
  });
}

export async function handleAcpPermissionsAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  return await withSingleTargetValue({
    commandParams: params,
    restTokens,
    usage: ACP_PERMISSIONS_USAGE,
    run: async ({ targetSessionKey, value }) =>
      await withAcpCommandErrorBoundary({
        run: async () => {
          const permissionProfile = validateRuntimePermissionProfileInput(value);
          const options = await getAcpSessionManager().setSessionConfigOption({
            cfg: params.cfg,
            sessionKey: targetSessionKey,
            key: "approval_policy",
            value: permissionProfile,
          });
          return {
            permissionProfile,
            options,
          };
        },
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "Could not update ACP permissions profile.",
        onSuccess: ({ permissionProfile, options }) =>
          stopWithText(
            `✅ Updated ACP permissions profile for ${targetSessionKey}: ${permissionProfile}. Effective options: ${formatRuntimeOptionsText(options)}`,
          ),
      }),
  });
}

export async function handleAcpTimeoutAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  return await withSingleTargetValue({
    commandParams: params,
    restTokens,
    usage: ACP_TIMEOUT_USAGE,
    run: async ({ targetSessionKey, value }) =>
      await withAcpCommandErrorBoundary({
        run: async () => {
          const timeoutSeconds = parseRuntimeTimeoutSecondsInput(value);
          const options = await getAcpSessionManager().setSessionConfigOption({
            cfg: params.cfg,
            sessionKey: targetSessionKey,
            key: "timeout",
            value: String(timeoutSeconds),
          });
          return {
            timeoutSeconds,
            options,
          };
        },
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "Could not update ACP timeout.",
        onSuccess: ({ timeoutSeconds, options }) =>
          stopWithText(
            `✅ Updated ACP timeout for ${targetSessionKey}: ${timeoutSeconds}s. Effective options: ${formatRuntimeOptionsText(options)}`,
          ),
      }),
  });
}

export async function handleAcpModelAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  return await withSingleTargetValue({
    commandParams: params,
    restTokens,
    usage: ACP_MODEL_USAGE,
    run: async ({ targetSessionKey, value }) =>
      await withAcpCommandErrorBoundary({
        run: async () => {
          const model = validateRuntimeModelInput(value);
          const options = await getAcpSessionManager().setSessionConfigOption({
            cfg: params.cfg,
            sessionKey: targetSessionKey,
            key: "model",
            value: model,
          });
          return {
            model,
            options,
          };
        },
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "Could not update ACP model.",
        onSuccess: ({ model, options }) =>
          stopWithText(
            `✅ Updated ACP model for ${targetSessionKey}: ${model}. Effective options: ${formatRuntimeOptionsText(options)}`,
          ),
      }),
  });
}

export async function handleAcpResetOptionsAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const targetSessionKey = await resolveOptionalSingleTargetOrStop({
    commandParams: params,
    restTokens,
    usage: ACP_RESET_OPTIONS_USAGE,
  });
  if (typeof targetSessionKey !== "string") {
    return targetSessionKey;
  }

  return await withAcpCommandErrorBoundary({
    run: async () =>
      await getAcpSessionManager().resetSessionRuntimeOptions({
        cfg: params.cfg,
        sessionKey: targetSessionKey,
      }),
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not reset ACP runtime options.",
    onSuccess: () => stopWithText(`✅ Reset ACP runtime options for ${targetSessionKey}.`),
  });
}
