import { callGateway } from "../../../gateway/call.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import { resolveEffectiveResetTargetSessionKey } from "../acp-reset-target.js";
import { resolveRequesterSessionKey } from "../commands-subagents/shared.js";
import type { HandleCommandsParams } from "../commands-types.js";
import { resolveAcpCommandBindingContext } from "./context.js";
import { SESSION_ID_RE } from "./shared.js";

type SessionTokenResolution = { ok: true; sessionKey: string } | { ok: false; error?: string };

function tokenMatchesBoundLabel(params: { token: string; label?: unknown }): boolean {
  const label = normalizeOptionalString(params.label);
  if (!label) {
    return false;
  }
  return label.toLocaleLowerCase() === params.token.toLocaleLowerCase();
}

function resolveBoundAcpThreadSessionKeyForMatchingToken(params: {
  commandParams: HandleCommandsParams;
  token: string;
}): string | undefined {
  const token = normalizeOptionalString(params.token) ?? "";
  if (!token) {
    return undefined;
  }
  const bindingContext = resolveAcpCommandBindingContext(params.commandParams);
  const conversationId = normalizeOptionalString(bindingContext.conversationId) ?? "";
  if (!bindingContext.channel || !conversationId) {
    return undefined;
  }
  const binding = getSessionBindingService().resolveByConversation({
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId,
    ...(bindingContext.parentConversationId
      ? { parentConversationId: bindingContext.parentConversationId }
      : {}),
  });
  if (binding?.targetKind !== "session") {
    return undefined;
  }
  const boundSessionKey = normalizeOptionalString(binding.targetSessionKey) ?? "";
  if (!boundSessionKey) {
    return undefined;
  }
  if (
    boundSessionKey === token ||
    tokenMatchesBoundLabel({ token, label: binding.metadata?.label })
  ) {
    return boundSessionKey;
  }
  return undefined;
}

async function resolveSessionKeyByToken(token: string): Promise<SessionTokenResolution> {
  const trimmed = token.trim();
  if (!trimmed) {
    return { ok: false };
  }
  const attempts: Array<Record<string, string>> = [{ key: trimmed }];
  if (SESSION_ID_RE.test(trimmed)) {
    attempts.push({ sessionId: trimmed });
  }
  attempts.push({ label: trimmed });
  let labelError: string | undefined;

  for (const params of attempts) {
    try {
      const resolved = await callGateway({
        method: "sessions.resolve",
        params,
        timeoutMs: 8_000,
      });
      const key = normalizeOptionalString(resolved?.key) ?? "";
      if (key) {
        return { ok: true, sessionKey: key };
      }
    } catch (error) {
      if (params.label) {
        labelError = formatErrorMessage(error);
      }
      // Try next resolver strategy.
    }
  }
  return { ok: false, ...(labelError ? { error: labelError } : {}) };
}

export function resolveBoundAcpThreadSessionKey(params: HandleCommandsParams): string | undefined {
  const commandTargetSessionKey = normalizeOptionalString(params.ctx.CommandTargetSessionKey) ?? "";
  const activeSessionKey =
    commandTargetSessionKey || (normalizeOptionalString(params.sessionKey) ?? "");
  const bindingContext = resolveAcpCommandBindingContext(params);
  return resolveEffectiveResetTargetSessionKey({
    cfg: params.cfg,
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    parentConversationId: bindingContext.parentConversationId,
    activeSessionKey,
    allowNonAcpBindingSessionKey: true,
    skipConfiguredFallbackWhenActiveSessionNonAcp: false,
  });
}

export async function resolveAcpTargetSessionKey(params: {
  commandParams: HandleCommandsParams;
  token?: string;
}): Promise<{ ok: true; sessionKey: string } | { ok: false; error: string }> {
  const token = normalizeOptionalString(params.token) ?? "";
  if (token) {
    const currentBound = resolveBoundAcpThreadSessionKeyForMatchingToken({
      commandParams: params.commandParams,
      token,
    });
    if (currentBound) {
      return { ok: true, sessionKey: currentBound };
    }
    const resolved = await resolveSessionKeyByToken(token);
    if (resolved.ok) {
      return { ok: true, sessionKey: resolved.sessionKey };
    }
    // Token was supplied but could not be resolved as a session key/id/label.
    // Fall through to thread-bound resolution so that callers that auto-fill
    // the current thread ID as the token (e.g. Discord slash commands) still
    // reach the correct session via the binding context.
    if (resolved.error) {
      const threadBound = resolveBoundAcpThreadSessionKey(params.commandParams);
      if (threadBound) {
        return {
          ok: true,
          sessionKey: threadBound,
        };
      }
      return {
        ok: false,
        error: resolved.error,
      };
    }
  }

  const threadBound = resolveBoundAcpThreadSessionKey(params.commandParams);
  if (threadBound) {
    return {
      ok: true,
      sessionKey: threadBound,
    };
  }

  if (token) {
    return {
      ok: false,
      error: `Unable to resolve session target: ${token}`,
    };
  }

  const fallback = resolveRequesterSessionKey(params.commandParams, {
    preferCommandTarget: true,
  });
  if (!fallback) {
    return {
      ok: false,
      error: "Missing session key.",
    };
  }
  return {
    ok: true,
    sessionKey: fallback,
  };
}
