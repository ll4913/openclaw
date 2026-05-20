import { callGateway } from "../../../gateway/call.js";
import { normalizeConversationRef } from "../../../infra/outbound/session-binding-normalization.js";
import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import { isAcpSessionKey } from "../../../routing/session-key.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import { resolveEffectiveResetTargetSessionKey } from "../acp-reset-target.js";
import { resolveRequesterSessionKey } from "../commands-subagents/shared.js";
import type { HandleCommandsParams } from "../commands-types.js";
import { resolveAcpCommandBindingContext } from "./context.js";
import { SESSION_ID_RE } from "./shared.js";

async function resolveSessionKeyByToken(token: string): Promise<string | null> {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }
  const attempts: Array<Record<string, string>> = [{ key: trimmed }];
  if (SESSION_ID_RE.test(trimmed)) {
    attempts.push({ sessionId: trimmed });
  }
  attempts.push({ label: trimmed });

  for (const params of attempts) {
    try {
      const resolved = await callGateway({
        method: "sessions.resolve",
        params,
        timeoutMs: 8_000,
      });
      const key = normalizeOptionalString(resolved?.key) ?? "";
      if (key) {
        return key;
      }
    } catch {
      // Try next resolver strategy.
    }
  }
  return null;
}

function resolveCurrentBoundAcpSessionKeyMatchingToken(params: {
  commandParams: HandleCommandsParams;
  token: string;
}): string | undefined {
  const token = normalizeOptionalString(params.token) ?? "";
  if (!token) {
    return undefined;
  }

  const bindingContext = resolveAcpCommandBindingContext(params.commandParams);
  if (!bindingContext.channel || !bindingContext.conversationId) {
    return undefined;
  }

  const binding = getSessionBindingService().resolveByConversation(
    normalizeConversationRef({
      channel: bindingContext.channel,
      accountId: bindingContext.accountId,
      conversationId: bindingContext.conversationId,
      parentConversationId: bindingContext.parentConversationId,
    }),
  );
  const targetSessionKey = normalizeOptionalString(binding?.targetSessionKey) ?? "";
  if (!isAcpSessionKey(targetSessionKey)) {
    return undefined;
  }
  if (token === targetSessionKey) {
    return targetSessionKey;
  }

  const bindingLabel = normalizeOptionalString(binding?.metadata?.label) ?? "";
  if (bindingLabel && token === bindingLabel) {
    return targetSessionKey;
  }
  return undefined;
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
    const currentBoundSessionKey = resolveCurrentBoundAcpSessionKeyMatchingToken({
      commandParams: params.commandParams,
      token,
    });
    if (currentBoundSessionKey) {
      return {
        ok: true,
        sessionKey: currentBoundSessionKey,
      };
    }

    const resolved = await resolveSessionKeyByToken(token);
    if (resolved) {
      return { ok: true, sessionKey: resolved };
    }
    // Token was supplied but could not be resolved as a session key/id/label.
    // Fall through to thread-bound resolution so that callers that auto-fill
    // the current thread ID as the token (e.g. Discord slash commands) still
    // reach the correct session via the binding context.
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
