import type { AcpTurnAttachment, SessionAcpMeta } from "../../acp/control-plane/manager.types.js";
import { resolveAcpAgentPolicyError, resolveAcpDispatchPolicyError } from "../../acp/policy.js";
import { formatAcpRuntimeErrorText } from "../../acp/runtime/error-text.js";
import { toAcpRuntimeError } from "../../acp/runtime/errors.js";
import type { AcpRuntimeError } from "../../acp/runtime/errors.js";
import { resolveAcpThreadSessionDetailLines } from "../../acp/runtime/session-identifiers.js";
import {
  isSessionIdentityPending,
  resolveSessionIdentityFromMeta,
} from "../../acp/runtime/session-identity.js";
import type { AcpRuntimeEvent } from "../../acp/runtime/types.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { appendXPromptContext } from "../../content/prompt-context.js";
import { logVerbose } from "../../globals.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { logAgentTurnLifecycle } from "../../infra/agent-turn-lifecycle.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { generateSecureUuid } from "../../infra/secure-random.js";
import { prefixSystemMessage } from "../../infra/system-message.js";
import { markDiagnosticSessionProgress } from "../../logging/diagnostic.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { resolveStatusTtsSnapshot } from "../../tts/status-config.js";
import { resolveConfiguredTtsMode } from "../../tts/tts-config.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import { buildInboundMediaNote } from "../media-note.js";
import { markReplyPayloadAsTtsSupplement } from "../reply-payload.js";
import type { FinalizedMsgContext } from "../templating.js";
import { createAcpReplyProjector } from "./acp-projector.js";
import { resolveAcpProjectionSettings } from "./acp-stream-settings.js";
import {
  loadAgentTurnMediaRuntime,
  resolveAgentTurnAttachments,
  resolveInlineAgentImageAttachments,
} from "./agent-turn-attachments.js";
import {
  createAcpDispatchDeliveryCoordinator,
  type AcpDispatchDeliveryCoordinator,
} from "./dispatch-acp-delivery.js";
import { appendRecentHistoryImageContext } from "./history-media.js";
import { hasInboundMedia } from "./inbound-media.js";
import type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";

const dispatchAcpManagerRuntimeLoader = createLazyImportLoader(
  () => import("./dispatch-acp-manager.runtime.js"),
);
const dispatchAcpSessionRuntimeLoader = createLazyImportLoader(
  () => import("./dispatch-acp-session.runtime.js"),
);
const dispatchAcpTtsRuntimeLoader = createLazyImportLoader(
  () => import("./dispatch-acp-tts.runtime.js"),
);
const dispatchAcpTranscriptRuntimeLoader = createLazyImportLoader(
  () => import("./dispatch-acp-transcript.runtime.js"),
);

function loadDispatchAcpManagerRuntime() {
  return dispatchAcpManagerRuntimeLoader.load();
}

function loadDispatchAcpSessionRuntime() {
  return dispatchAcpSessionRuntimeLoader.load();
}

function loadDispatchAcpTtsRuntime() {
  return dispatchAcpTtsRuntimeLoader.load();
}

function loadDispatchAcpTranscriptRuntime() {
  return dispatchAcpTranscriptRuntimeLoader.load();
}

type DispatchProcessedRecorder = (
  outcome: "completed" | "skipped" | "error",
  opts?: {
    reason?: string;
    error?: string;
  },
) => void;

type AcpPreparedTurn = {
  promptText: string;
  text: string;
  attachments?: AcpTurnAttachment[];
};

type AcpDispatchSessionManager = {
  initializeSession: (input: {
    cfg: OpenClawConfig;
    sessionKey: string;
    agent: string;
    mode: "persistent" | "oneshot";
    cwd?: string;
  }) => Promise<{ meta?: SessionAcpMeta } | void>;
  runTurn: (input: {
    cfg: OpenClawConfig;
    sessionKey: string;
    text: string;
    attachments?: AcpTurnAttachment[];
    mode: "prompt";
    requestId: string;
    signal?: AbortSignal;
    onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void;
  }) => Promise<void>;
};

function resolveFirstContextText(
  ctx: FinalizedMsgContext,
  keys: Array<"BodyForAgent" | "BodyForCommands" | "CommandBody" | "RawBody" | "Body">,
): string {
  for (const key of keys) {
    const value = ctx[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function resolveAcpPromptText(ctx: FinalizedMsgContext): string {
  const promptText = resolveFirstContextText(ctx, [
    "BodyForAgent",
    "BodyForCommands",
    "CommandBody",
    "RawBody",
    "Body",
  ]).trim();
  const mediaNote = buildInboundMediaNote(ctx, {
    onlyManagedInboundPaths: true,
    preserveManagedInboundPaths: true,
  });
  if (!mediaNote) {
    return promptText;
  }
  return [mediaNote, promptText || "[User sent media without caption]"]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function resolveAcpRequestId(ctx: FinalizedMsgContext): string {
  const id = ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  if (typeof id === "string") {
    const normalizedId = normalizeOptionalString(id);
    if (normalizedId) {
      return normalizedId;
    }
  }
  if (typeof id === "number" || typeof id === "bigint") {
    return String(id);
  }
  return generateSecureUuid();
}

function resolveAcpTurnText(params: {
  promptText: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  channel?: string;
}): string {
  const guidanceBlocks: string[] = [];
  if (normalizeOptionalLowercaseString(params.channel) === "telegram") {
    guidanceBlocks.push(
      prefixSystemMessage(
        [
          "When the answer is a task completion report or multi-step status update, make the final visible reply easy to scan in Telegram.",
          "Use sparse emoji section labels such as ✅ 结果, 🔧 改动, 🧪 验证, ⚠️ 注意, and ➡️ 下一步.",
          "Preserve technical details, paths, commands, and verification results; do not add decorative emoji to every line.",
        ].join(" "),
      ),
    );
  }
  if (params.sourceReplyDeliveryMode === "message_tool_only") {
    guidanceBlocks.push(
      prefixSystemMessage(
        [
          "Source channel delivery is private by default for this turn.",
          "Normal ACP final output will not be automatically posted to the source channel.",
          "To send visible output, use message(action=send). The target defaults to the current source channel.",
        ].join(" "),
      ),
    );
  }
  return [...guidanceBlocks, params.promptText].filter(Boolean).join("\n\n");
}

async function hasBoundConversationForSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  channelRaw: string | undefined;
  accountIdRaw: string | undefined;
}): Promise<boolean> {
  const channel = normalizeOptionalLowercaseString(params.channelRaw) ?? "";
  if (!channel) {
    return false;
  }
  const accountId = normalizeOptionalLowercaseString(params.accountIdRaw) ?? "";
  const channels = params.cfg.channels as Record<string, { defaultAccount?: unknown } | undefined>;
  const configuredDefaultAccountId = channels?.[channel]?.defaultAccount;
  const normalizedAccountId =
    accountId || normalizeOptionalLowercaseString(configuredDefaultAccountId) || "default";
  const { getSessionBindingService } = await loadDispatchAcpManagerRuntime();
  const bindingService = getSessionBindingService();
  const bindings = bindingService.listBySession(params.sessionKey);
  return bindings.some((binding) => {
    const bindingChannel = normalizeOptionalLowercaseString(binding.conversation.channel) ?? "";
    const bindingAccountId = normalizeOptionalLowercaseString(binding.conversation.accountId) ?? "";
    const conversationId = normalizeOptionalString(binding.conversation.conversationId) ?? "";
    return (
      bindingChannel === channel &&
      (bindingAccountId || "default") === normalizedAccountId &&
      conversationId.length > 0
    );
  });
}

export type AcpDispatchAttemptResult = {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
};

const ACP_STALE_BINDING_UNBIND_REASON = "acp-session-init-failed";

function isStaleSessionInitError(params: { code: string; message: string }): boolean {
  if (params.code !== "ACP_SESSION_INIT_FAILED") {
    return false;
  }
  return /(ACP (session )?metadata is missing|missing ACP metadata|Session is not ACP-enabled|Resource not found)/i.test(
    params.message,
  );
}

async function maybeUnbindStaleBoundConversations(params: {
  targetSessionKey: string;
  error: { code: string; message: string };
}): Promise<void> {
  if (!isStaleSessionInitError(params.error)) {
    return;
  }
  try {
    const { getSessionBindingService } = await loadDispatchAcpManagerRuntime();
    const removed = await getSessionBindingService().unbind({
      targetSessionKey: params.targetSessionKey,
      reason: ACP_STALE_BINDING_UNBIND_REASON,
    });
    if (removed.length > 0) {
      logVerbose(
        `dispatch-acp: removed ${removed.length} stale bound conversation(s) for ${params.targetSessionKey} after ${params.error.code}: ${params.error.message}`,
      );
    }
  } catch (error) {
    logVerbose(
      `dispatch-acp: failed to unbind stale bound conversations for ${params.targetSessionKey}: ${formatErrorMessage(error)}`,
    );
  }
}

function resolveAcpFailoverAgents(params: {
  cfg: OpenClawConfig;
  primaryAgentId: string;
}): string[] {
  const failover = params.cfg.acp?.failover;
  if (!failover?.enabled) {
    return [];
  }
  const primaryAgentId = normalizeOptionalLowercaseString(params.primaryAgentId) ?? "";
  const configuredChain =
    (primaryAgentId ? failover.agents?.[primaryAgentId] : undefined) ?? failover.defaultChain ?? [];
  const seen = new Set<string>();
  const agents: string[] = [];
  for (const rawAgentId of configuredChain) {
    const agentId = normalizeOptionalString(rawAgentId);
    const normalizedAgentId = normalizeOptionalLowercaseString(agentId);
    if (!agentId || !normalizedAgentId || normalizedAgentId === primaryAgentId) {
      continue;
    }
    if (seen.has(normalizedAgentId)) {
      continue;
    }
    seen.add(normalizedAgentId);
    agents.push(agentId);
  }
  return agents;
}

function resolveFailoverCwd(primaryMeta?: SessionAcpMeta): string | undefined {
  return (
    normalizeOptionalString(primaryMeta?.runtimeOptions?.cwd) ??
    normalizeOptionalString(primaryMeta?.cwd)
  );
}

function buildAcpFailoverPrompt(params: {
  originalText: string;
  primaryAgentId: string;
  primarySessionKey: string;
  fallbackAgentId: string;
  error: AcpRuntimeError;
}): string {
  return prefixSystemMessage(
    [
      `The previous ACP worker (${params.primaryAgentId}) failed before completing this user request.`,
      `Continue the task with ${params.fallbackAgentId}.`,
      "Inspect current state before editing, preserve any partial useful work, and give the user a visible final result or failure explanation.",
      "",
      `Primary session: ${params.primarySessionKey}`,
      `Primary failure: ${params.error.code}: ${params.error.message}`,
      "",
      "Original user request:",
      params.originalText,
    ].join("\n"),
  );
}

async function maybeRebindFailoverConversations(params: {
  fromSessionKey: string;
  toSessionKey: string;
}): Promise<void> {
  try {
    const { getSessionBindingService } = await loadDispatchAcpManagerRuntime();
    const bindingService = getSessionBindingService();
    const bindings = bindingService.listBySession(params.fromSessionKey);
    for (const binding of bindings) {
      await bindingService.bind({
        targetSessionKey: params.toSessionKey,
        targetKind: "session",
        conversation: binding.conversation,
      });
    }
    if (bindings.length > 0) {
      logVerbose(
        `dispatch-acp: rebound ${bindings.length} conversation(s) from ${params.fromSessionKey} to failover session ${params.toSessionKey}`,
      );
    }
  } catch (error) {
    logVerbose(
      `dispatch-acp: failed to rebind failover conversations from ${params.fromSessionKey} to ${params.toSessionKey}: ${formatErrorMessage(error)}`,
    );
  }
}

async function tryRunAcpFailoverTurn(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  dispatcher: ReplyDispatcher;
  acpManager: AcpDispatchSessionManager;
  primarySessionKey: string;
  primaryAgentId: string;
  primaryMeta?: SessionAcpMeta;
  preparedTurn: AcpPreparedTurn | null;
  error: AcpRuntimeError;
  inboundAudio: boolean;
  sessionTtsAuto?: TtsAutoMode;
  ttsChannel?: string;
  suppressUserDelivery?: boolean;
  suppressReplyLifecycle?: boolean;
  shouldRouteToOriginating: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  shouldSendToolSummaries: boolean;
  abortSignal?: AbortSignal;
  requestId: string;
  effectiveDispatchAccountId?: string;
}): Promise<AcpDispatchAttemptResult | null> {
  if (params.abortSignal?.aborted || !params.preparedTurn) {
    return null;
  }
  const failoverAgents = resolveAcpFailoverAgents({
    cfg: params.cfg,
    primaryAgentId: params.primaryAgentId,
  });
  if (failoverAgents.length === 0) {
    return null;
  }

  for (const fallbackAgentId of failoverAgents) {
    const policyError = resolveAcpAgentPolicyError(params.cfg, fallbackAgentId);
    if (policyError) {
      logVerbose(
        `dispatch-acp: skipping failover agent ${fallbackAgentId} because policy denied it: ${policyError.message}`,
      );
      continue;
    }

    const fallbackSessionKey = `agent:${fallbackAgentId}:acp:${generateSecureUuid()}`;
    const fallbackDelivery = createAcpDispatchDeliveryCoordinator({
      cfg: params.cfg,
      agentId: fallbackAgentId,
      ctx: params.ctx,
      dispatcher: params.dispatcher,
      inboundAudio: params.inboundAudio,
      sessionKey: fallbackSessionKey,
      sessionTtsAuto: params.sessionTtsAuto,
      ttsChannel: params.ttsChannel,
      suppressUserDelivery: params.suppressUserDelivery,
      suppressReplyLifecycle: params.suppressReplyLifecycle,
      shouldRouteToOriginating: params.shouldRouteToOriginating,
      originatingChannel: params.originatingChannel,
      originatingTo: params.originatingTo,
    });
    const fallbackProjector = createAcpReplyProjector({
      cfg: params.cfg,
      shouldSendToolSummaries: params.shouldSendToolSummaries,
      deliver: fallbackDelivery.deliver,
      provider: params.ctx.Surface ?? params.ctx.Provider,
      accountId: params.effectiveDispatchAccountId,
    });

    try {
      await fallbackDelivery.deliver(
        "final",
        {
          text: prefixSystemMessage(
            `ACP worker ${params.primaryAgentId} failed (${params.error.code}). Trying ${fallbackAgentId} now.`,
          ),
          isFallbackNotice: true,
        },
        { skipTts: true },
      );
      const initialized = await params.acpManager.initializeSession({
        cfg: params.cfg,
        sessionKey: fallbackSessionKey,
        agent: fallbackAgentId,
        mode: "persistent",
        cwd: resolveFailoverCwd(params.primaryMeta),
      });
      await maybeRebindFailoverConversations({
        fromSessionKey: params.primarySessionKey,
        toSessionKey: fallbackSessionKey,
      });
      try {
        await fallbackDelivery.startReplyLifecycle();
      } catch (error) {
        logVerbose(
          `dispatch-acp: start failover reply lifecycle failed: ${formatErrorMessage(error)}`,
        );
      }
      await params.acpManager.runTurn({
        cfg: params.cfg,
        sessionKey: fallbackSessionKey,
        text: buildAcpFailoverPrompt({
          originalText: params.preparedTurn.text,
          primaryAgentId: params.primaryAgentId,
          primarySessionKey: params.primarySessionKey,
          fallbackAgentId,
          error: params.error,
        }),
        attachments: params.preparedTurn.attachments,
        mode: "prompt",
        requestId: `${params.requestId}:failover:${fallbackAgentId}`,
        ...(params.abortSignal ? { signal: params.abortSignal } : {}),
        onEvent: async (event) => await fallbackProjector.onEvent(event),
      });
      await fallbackProjector.flush(true);
      if (params.abortSignal?.aborted) {
        const counts = params.dispatcher.getQueuedCounts();
        fallbackDelivery.applyRoutedCounts(counts);
        return { queuedFinal: false, counts };
      }
      try {
        const { persistAcpDispatchTranscript } = await loadDispatchAcpTranscriptRuntime();
        await persistAcpDispatchTranscript({
          cfg: params.cfg,
          sessionKey: fallbackSessionKey,
          promptText: params.preparedTurn.promptText,
          finalText:
            fallbackDelivery.getAccumulatedFinalText() ||
            fallbackDelivery.getAccumulatedBlockText(),
          meta: initialized?.meta,
          threadId: params.ctx.MessageThreadId,
        });
      } catch (error) {
        logVerbose(
          `dispatch-acp: failover transcript persistence failed for ${fallbackSessionKey}: ${formatErrorMessage(
            error,
          )}`,
        );
      }
      let queuedFinal = await finalizeAcpTurnOutput({
        cfg: params.cfg,
        sessionKey: fallbackSessionKey,
        agentId: fallbackAgentId,
        delivery: fallbackDelivery,
        inboundAudio: params.inboundAudio,
        sessionTtsAuto: params.sessionTtsAuto,
        ttsChannel: params.ttsChannel ?? params.ctx.Surface ?? params.ctx.Provider,
        ttsAccountId: params.effectiveDispatchAccountId,
        shouldEmitResolvedIdentityNotice: false,
      });
      if (!queuedFinal && !fallbackDelivery.hasDeliveredAnyPayload()) {
        queuedFinal =
          (await fallbackDelivery.deliver(
            "final",
            {
              text: prefixSystemMessage(
                `ACP failover to ${fallbackAgentId} completed without visible output. Run /acp status if this keeps happening.`,
              ),
              isFallbackNotice: true,
            },
            { skipTts: true },
          )) || queuedFinal;
      }
      const counts = params.dispatcher.getQueuedCounts();
      fallbackDelivery.applyRoutedCounts(counts);
      logVerbose(
        `dispatch-acp: failover ok primary=${params.primarySessionKey} fallback=${fallbackSessionKey} agent=${fallbackAgentId}`,
      );
      return { queuedFinal, counts };
    } catch (error) {
      await fallbackProjector.flush(true);
      logVerbose(
        `dispatch-acp: failover agent ${fallbackAgentId} failed after ${params.primarySessionKey}: ${formatErrorMessage(error)}`,
      );
    }
  }

  return null;
}

async function finalizeAcpTurnOutput(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  delivery: AcpDispatchDeliveryCoordinator;
  inboundAudio: boolean;
  sessionTtsAuto?: TtsAutoMode;
  ttsChannel?: string;
  ttsAccountId?: string;
  shouldEmitResolvedIdentityNotice: boolean;
}): Promise<boolean> {
  await params.delivery.settleVisibleText();
  let queuedFinal =
    params.delivery.hasDeliveredVisibleText() && !params.delivery.hasFailedVisibleTextDelivery();
  const shouldFinalizeLiveTelegramBlockText =
    normalizeOptionalLowercaseString(params.ttsChannel) === "telegram" &&
    resolveAcpProjectionSettings(params.cfg).deliveryMode === "live";
  const ttsMode = resolveConfiguredTtsMode(params.cfg, {
    agentId: params.agentId,
    channelId: params.ttsChannel,
    accountId: params.ttsAccountId,
  });
  const accumulatedVisibleBlockText = params.delivery.getAccumulatedVisibleBlockText();
  const accumulatedBlockTtsText = params.delivery.getAccumulatedBlockTtsText();
  const hasAccumulatedBlockText = accumulatedBlockTtsText.trim().length > 0;
  const ttsStatus = resolveStatusTtsSnapshot({
    cfg: params.cfg,
    sessionAuto: params.sessionTtsAuto,
    agentId: params.agentId,
    channelId: params.ttsChannel,
    accountId: params.ttsAccountId,
  });
  const canAttemptFinalTts =
    ttsStatus != null && !(ttsStatus.autoMode === "inbound" && !params.inboundAudio);

  let finalMediaDelivered = false;
  if (ttsMode === "final" && hasAccumulatedBlockText && canAttemptFinalTts) {
    try {
      const { maybeApplyTtsToPayload } = await loadDispatchAcpTtsRuntime();
      const ttsSyntheticReply = await maybeApplyTtsToPayload({
        payload: { text: accumulatedBlockTtsText },
        cfg: params.cfg,
        channel: params.ttsChannel,
        kind: "final",
        inboundAudio: params.inboundAudio,
        ttsAuto: params.sessionTtsAuto,
        agentId: params.agentId,
        accountId: params.ttsAccountId,
      });
      if (ttsSyntheticReply.mediaUrl) {
        const delivered = await params.delivery.deliver(
          "final",
          markReplyPayloadAsTtsSupplement(
            {
              mediaUrl: ttsSyntheticReply.mediaUrl,
              audioAsVoice: ttsSyntheticReply.audioAsVoice,
              spokenText: accumulatedBlockTtsText,
              trustedLocalMedia: true,
            },
            accumulatedBlockTtsText,
            { visibleTextAlreadyDelivered: true },
          ),
        );
        queuedFinal = queuedFinal || delivered;
        finalMediaDelivered = delivered;
      }
    } catch (err) {
      logVerbose(`dispatch-acp: accumulated ACP block TTS failed: ${formatErrorMessage(err)}`);
    }
  }

  // Some ACP parent surfaces only expose terminal replies, so block routing alone is not enough
  // to prove the final result was visible to the user.
  const shouldDeliverTextFallback =
    ttsMode !== "all" &&
    accumulatedVisibleBlockText.trim().length > 0 &&
    !finalMediaDelivered &&
    !params.delivery.hasDeliveredFinalReply() &&
    (shouldFinalizeLiveTelegramBlockText ||
      !params.delivery.hasDeliveredVisibleText() ||
      params.delivery.hasFailedVisibleTextDelivery());
  if (shouldDeliverTextFallback) {
    const delivered = await params.delivery.deliver(
      "final",
      { text: accumulatedVisibleBlockText },
      { skipTts: true },
    );
    queuedFinal = queuedFinal || delivered;
  }

  const hasAssistantOutput =
    accumulatedVisibleBlockText.trim().length > 0 ||
    params.delivery.getAccumulatedFinalText().trim().length > 0;
  if (params.shouldEmitResolvedIdentityNotice && !hasAssistantOutput) {
    const { readAcpSessionEntry } = await loadDispatchAcpSessionRuntime();
    const currentMeta = readAcpSessionEntry({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    })?.acp;
    const identityAfterTurn = resolveSessionIdentityFromMeta(currentMeta);
    if (!isSessionIdentityPending(identityAfterTurn)) {
      const resolvedDetails = resolveAcpThreadSessionDetailLines({
        sessionKey: params.sessionKey,
        meta: currentMeta,
      });
      if (resolvedDetails.length > 0) {
        const delivered = await params.delivery.deliver("final", {
          text: prefixSystemMessage(["Session ids resolved.", ...resolvedDetails].join("\n")),
        });
        queuedFinal = queuedFinal || delivered;
      }
    }
  }

  if (!hasAssistantOutput && !params.delivery.hasDeliveredFinalReply()) {
    const delivered = await params.delivery.deliver(
      "final",
      {
        text: prefixSystemMessage(
          "ACP completed without visible output or a final answer. It only produced internal progress, so I did not silently drop this turn. Run /acp status if this keeps happening.",
        ),
        isFallbackNotice: true,
      },
      { skipTts: true },
    );
    queuedFinal = queuedFinal || delivered;
  }

  return queuedFinal;
}

export async function tryDispatchAcpReply(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  runId?: string;
  sessionKey?: string;
  images?: Array<{ data: string; mimeType: string }>;
  abortSignal?: AbortSignal;
  inboundAudio: boolean;
  sessionTtsAuto?: TtsAutoMode;
  ttsChannel?: string;
  suppressUserDelivery?: boolean;
  suppressReplyLifecycle?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  shouldRouteToOriginating: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  shouldSendToolSummaries: boolean;
  bypassForCommand: boolean;
  onReplyStart?: () => Promise<void> | void;
  recordProcessed: DispatchProcessedRecorder;
  markIdle: (reason: string) => void;
}): Promise<AcpDispatchAttemptResult | null> {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey || params.bypassForCommand) {
    return null;
  }

  const { getAcpSessionManager } = await loadDispatchAcpManagerRuntime();
  const acpManager = getAcpSessionManager();
  const acpResolution = acpManager.resolveSession({
    cfg: params.cfg,
    sessionKey,
  });
  if (acpResolution.kind === "none") {
    return null;
  }
  const canonicalSessionKey = acpResolution.sessionKey;
  const acpAgentId = resolveAgentIdFromSessionKey(canonicalSessionKey);
  const progressSessionKeys = isDiagnosticsEnabled(params.cfg)
    ? Array.from(
        new Set(
          [params.ctx.SessionKey, sessionKey, canonicalSessionKey]
            .map((key) => normalizeOptionalString(key))
            .filter((key): key is string => Boolean(key)),
        ),
      )
    : [];
  const markAcpProgress =
    progressSessionKeys.length > 0
      ? () => {
          for (const key of progressSessionKeys) {
            markDiagnosticSessionProgress({ sessionKey: key });
          }
        }
      : undefined;

  let queuedFinal = false;
  const delivery = createAcpDispatchDeliveryCoordinator({
    cfg: params.cfg,
    agentId: acpAgentId,
    ctx: params.ctx,
    dispatcher: params.dispatcher,
    inboundAudio: params.inboundAudio,
    sessionKey: canonicalSessionKey,
    sessionTtsAuto: params.sessionTtsAuto,
    ttsChannel: params.ttsChannel,
    suppressUserDelivery: params.suppressUserDelivery,
    suppressReplyLifecycle: params.suppressReplyLifecycle,
    shouldRouteToOriginating: params.shouldRouteToOriginating,
    originatingChannel: params.originatingChannel,
    originatingTo: params.originatingTo,
    onReplyStart: params.onReplyStart,
    abortSignal: params.abortSignal,
  });

  const identityPendingBeforeTurn = isSessionIdentityPending(
    resolveSessionIdentityFromMeta(acpResolution.kind === "ready" ? acpResolution.meta : undefined),
  );
  const shouldEmitResolvedIdentityNotice =
    !params.suppressUserDelivery &&
    identityPendingBeforeTurn &&
    (Boolean(
      params.ctx.MessageThreadId != null &&
      (normalizeOptionalString(String(params.ctx.MessageThreadId)) ?? ""),
    ) ||
      (await hasBoundConversationForSession({
        cfg: params.cfg,
        sessionKey: canonicalSessionKey,
        channelRaw: params.ctx.OriginatingChannel ?? params.ctx.Surface ?? params.ctx.Provider,
        accountIdRaw: params.ctx.AccountId,
      })));

  const resolvedAcpAgent =
    acpResolution.kind === "ready"
      ? (normalizeOptionalString(acpResolution.meta.agent) ??
        normalizeOptionalString(params.cfg.acp?.defaultAgent) ??
        resolveAgentIdFromSessionKey(canonicalSessionKey))
      : resolveAgentIdFromSessionKey(canonicalSessionKey);
  const normalizedDispatchChannel = normalizeOptionalLowercaseString(
    params.ctx.OriginatingChannel ?? params.ctx.Surface ?? params.ctx.Provider,
  );
  const explicitDispatchAccountId = normalizeOptionalString(params.ctx.AccountId);
  const dispatchChannels = params.cfg.channels as
    | Record<string, { defaultAccount?: unknown } | undefined>
    | undefined;
  const defaultDispatchAccount =
    normalizedDispatchChannel == null
      ? undefined
      : dispatchChannels?.[normalizedDispatchChannel]?.defaultAccount;
  const effectiveDispatchAccountId =
    explicitDispatchAccountId ?? normalizeOptionalString(defaultDispatchAccount);
  const projector = createAcpReplyProjector({
    cfg: params.cfg,
    shouldSendToolSummaries: params.shouldSendToolSummaries,
    deliver: delivery.deliver,
    onProgress: markAcpProgress,
    provider: params.ctx.Surface ?? params.ctx.Provider,
    accountId: effectiveDispatchAccountId,
  });

  const acpDispatchStartedAt = Date.now();
  let preparedTurn: AcpPreparedTurn | null = null;
  const requestId = resolveAcpRequestId(params.ctx);
  logAgentTurnLifecycle({
    phase: "received",
    channel:
      normalizeOptionalLowercaseString(
        params.ctx.OriginatingChannel ?? params.ctx.Surface ?? params.ctx.Provider,
      ) ?? "acp",
    accountId: effectiveDispatchAccountId,
    agentId: acpAgentId,
    sessionKey: canonicalSessionKey,
    requestId,
    runtime: "acp",
  });
  try {
    const dispatchPolicyError = resolveAcpDispatchPolicyError(params.cfg);
    if (dispatchPolicyError) {
      throw dispatchPolicyError;
    }
    if (acpResolution.kind === "stale") {
      await maybeUnbindStaleBoundConversations({
        targetSessionKey: canonicalSessionKey,
        error: acpResolution.error,
      });
      const delivered = await delivery.deliver("final", {
        text: formatAcpRuntimeErrorText(acpResolution.error),
        isError: true,
      });
      const counts = params.dispatcher.getQueuedCounts();
      delivery.applyRoutedCounts(counts);
      const acpStats = acpManager.getObservabilitySnapshot(params.cfg);
      logVerbose(
        `acp-dispatch: session=${sessionKey} outcome=error code=${acpResolution.error.code} latencyMs=${Date.now() - acpDispatchStartedAt} queueDepth=${acpStats.turns.queueDepth} activeRuntimes=${acpStats.runtimeCache.activeSessions}`,
      );
      params.recordProcessed("completed", {
        reason: `acp_error:${normalizeLowercaseStringOrEmpty(acpResolution.error.code)}`,
      });
      params.markIdle("message_completed");
      return { queuedFinal: delivered, counts };
    }
    const agentPolicyError = resolveAcpAgentPolicyError(params.cfg, resolvedAcpAgent);
    if (agentPolicyError) {
      throw agentPolicyError;
    }
    if (hasInboundMedia(params.ctx) && !params.ctx.MediaUnderstanding?.length) {
      try {
        const { applyMediaUnderstanding } = await loadAgentTurnMediaRuntime();
        await applyMediaUnderstanding({
          ctx: params.ctx,
          cfg: params.cfg,
          agentDir: resolveAgentDir(params.cfg, acpAgentId),
          workspaceDir: resolveAgentWorkspaceDir(params.cfg, acpAgentId),
        });
      } catch (err) {
        logVerbose(
          `dispatch-acp: media understanding failed, proceeding with raw content: ${formatErrorMessage(err)}`,
        );
      }
    }

    const promptText = resolveAcpPromptText(params.ctx);
    const resolvedTurnAttachments = await resolveAgentTurnAttachments({
      ctx: params.ctx,
      cfg: params.cfg,
    });
    const mediaAttachments = resolvedTurnAttachments.attachments;
    const inlineAttachments = resolveInlineAgentImageAttachments(params.images);
    const mediaAttachmentsAreOnlyRecentHistory =
      mediaAttachments.length > 0 &&
      mediaAttachments.length === resolvedTurnAttachments.recentHistoryImages.length;
    const attachments =
      mediaAttachments.length > 0 &&
      !(mediaAttachmentsAreOnlyRecentHistory && inlineAttachments.length > 0)
        ? mediaAttachments
        : inlineAttachments;
    const promptWithRecentHistory =
      attachments === mediaAttachments
        ? appendRecentHistoryImageContext({
            promptText,
            images: resolvedTurnAttachments.recentHistoryImages,
          })
        : promptText;
    const turnPromptText = await appendXPromptContext(promptWithRecentHistory, { timeoutMs: 4000 });
    preparedTurn = {
      promptText: turnPromptText,
      text: resolveAcpTurnText({
        promptText: turnPromptText,
        sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
        channel: params.ctx.OriginatingChannel ?? params.ctx.Surface ?? params.ctx.Provider,
      }),
      attachments: attachments.length > 0 ? attachments : undefined,
    };
    if (!turnPromptText && attachments.length === 0) {
      const counts = params.dispatcher.getQueuedCounts();
      delivery.applyRoutedCounts(counts);
      params.recordProcessed("completed", { reason: "acp_empty_prompt" });
      params.markIdle("message_completed");
      return { queuedFinal: false, counts };
    }

    try {
      await delivery.startReplyLifecycle();
      logAgentTurnLifecycle({
        phase: "reply_lifecycle_started",
        channel: normalizedDispatchChannel ?? "acp",
        accountId: effectiveDispatchAccountId,
        agentId: acpAgentId,
        sessionKey: canonicalSessionKey,
        requestId,
        runtime: "acp",
        elapsedMs: Date.now() - acpDispatchStartedAt,
      });
    } catch (error) {
      logVerbose(`dispatch-acp: start reply lifecycle failed: ${formatErrorMessage(error)}`);
    }

    await acpManager.runTurn({
      cfg: params.cfg,
      sessionKey: canonicalSessionKey,
      text: preparedTurn.text,
      attachments: preparedTurn.attachments,
      mode: "prompt",
      requestId,
      ...(params.abortSignal ? { signal: params.abortSignal } : {}),
      onLifecycle: async (event) => {
        if (event.type === "prompt_submitted") {
          logAgentTurnLifecycle({
            phase: "prompt_submitted",
            channel: normalizedDispatchChannel ?? "acp",
            accountId: effectiveDispatchAccountId,
            agentId: acpAgentId,
            sessionKey: canonicalSessionKey,
            requestId,
            runtime: "acp",
            elapsedMs: event.at - acpDispatchStartedAt,
          });
        }
      },
      onEvent: async (event) => await projector.onEvent(event),
    });

    await projector.flush(true);
    if (params.abortSignal?.aborted) {
      const counts = params.dispatcher.getQueuedCounts();
      delivery.applyRoutedCounts(counts);
      params.recordProcessed("completed", { reason: "acp_aborted" });
      params.markIdle("message_aborted");
      return { queuedFinal, counts };
    }
    try {
      const { persistAcpDispatchTranscript } = await loadDispatchAcpTranscriptRuntime();
      await persistAcpDispatchTranscript({
        cfg: params.cfg,
        sessionKey: canonicalSessionKey,
        promptText: turnPromptText,
        finalText: delivery.getAccumulatedFinalText() || delivery.getAccumulatedBlockText(),
        meta: acpResolution.meta,
        threadId: params.ctx.MessageThreadId,
      });
    } catch (error) {
      logVerbose(
        `dispatch-acp: transcript persistence failed for ${canonicalSessionKey}: ${formatErrorMessage(
          error,
        )}`,
      );
    }
    queuedFinal =
      (await finalizeAcpTurnOutput({
        cfg: params.cfg,
        sessionKey: canonicalSessionKey,
        agentId: acpAgentId,
        delivery,
        inboundAudio: params.inboundAudio,
        sessionTtsAuto: params.sessionTtsAuto,
        ttsChannel: params.ttsChannel ?? params.ctx.Surface ?? params.ctx.Provider,
        ttsAccountId: effectiveDispatchAccountId,
        shouldEmitResolvedIdentityNotice,
      })) || queuedFinal;
    logAgentTurnLifecycle({
      phase: "final_delivery_done",
      channel: normalizedDispatchChannel ?? "acp",
      accountId: effectiveDispatchAccountId,
      agentId: acpAgentId,
      sessionKey: canonicalSessionKey,
      requestId,
      runtime: "acp",
      elapsedMs: Date.now() - acpDispatchStartedAt,
      outcome: queuedFinal || delivery.hasDeliveredAnyPayload() ? "visible_or_queued" : "missing",
    });
    if (!queuedFinal && !delivery.hasDeliveredAnyPayload()) {
      const delivered = await delivery.deliver(
        "final",
        {
          text: prefixSystemMessage(
            "ACP completed without visible output. Run /acp status if this keeps happening.",
          ),
          isFallbackNotice: true,
        },
        { skipTts: true },
      );
      queuedFinal = queuedFinal || delivered;
      logAgentTurnLifecycle({
        phase: "silent_fallback",
        channel: normalizedDispatchChannel ?? "acp",
        accountId: effectiveDispatchAccountId,
        agentId: acpAgentId,
        sessionKey: canonicalSessionKey,
        requestId,
        runtime: "acp",
        elapsedMs: Date.now() - acpDispatchStartedAt,
        outcome: delivered ? "delivered" : "failed",
      });
    }

    const counts = params.dispatcher.getQueuedCounts();
    delivery.applyRoutedCounts(counts);
    const acpStats = acpManager.getObservabilitySnapshot(params.cfg);
    const runId = normalizeOptionalString(params.runId);
    if (runId) {
      emitAgentEvent({
        runId,
        sessionKey,
        stream: "lifecycle",
        data: {
          phase: "end",
          startedAt: acpDispatchStartedAt,
          endedAt: Date.now(),
        },
      });
    }
    logVerbose(
      `acp-dispatch: session=${sessionKey} outcome=ok latencyMs=${Date.now() - acpDispatchStartedAt} queueDepth=${acpStats.turns.queueDepth} activeRuntimes=${acpStats.runtimeCache.activeSessions}`,
    );
    logAgentTurnLifecycle({
      phase: "turn_done",
      channel: normalizedDispatchChannel ?? "acp",
      accountId: effectiveDispatchAccountId,
      agentId: acpAgentId,
      sessionKey: canonicalSessionKey,
      requestId,
      runtime: "acp",
      elapsedMs: Date.now() - acpDispatchStartedAt,
      outcome: "ok",
    });
    params.recordProcessed("completed", { reason: "acp_dispatch" });
    params.markIdle("message_completed");
    return { queuedFinal, counts };
  } catch (err) {
    await projector.flush(true);
    const acpError = toAcpRuntimeError({
      error: err,
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "ACP turn failed before completion.",
    });
    await maybeUnbindStaleBoundConversations({
      targetSessionKey: canonicalSessionKey,
      error: acpError,
    });
    const failoverResult = await tryRunAcpFailoverTurn({
      cfg: params.cfg,
      ctx: params.ctx,
      dispatcher: params.dispatcher,
      acpManager,
      primarySessionKey: canonicalSessionKey,
      primaryAgentId: resolvedAcpAgent,
      primaryMeta: acpResolution.kind === "ready" ? acpResolution.meta : undefined,
      preparedTurn,
      error: acpError,
      inboundAudio: params.inboundAudio,
      sessionTtsAuto: params.sessionTtsAuto,
      ttsChannel: params.ttsChannel,
      suppressUserDelivery: params.suppressUserDelivery,
      suppressReplyLifecycle: params.suppressReplyLifecycle,
      shouldRouteToOriginating: params.shouldRouteToOriginating,
      originatingChannel: params.originatingChannel,
      originatingTo: params.originatingTo,
      shouldSendToolSummaries: params.shouldSendToolSummaries,
      abortSignal: params.abortSignal,
      requestId,
      effectiveDispatchAccountId,
    });
    if (failoverResult) {
      const acpStats = acpManager.getObservabilitySnapshot(params.cfg);
      logVerbose(
        `acp-dispatch: session=${sessionKey} outcome=failover code=${acpError.code} latencyMs=${Date.now() - acpDispatchStartedAt} queueDepth=${acpStats.turns.queueDepth} activeRuntimes=${acpStats.runtimeCache.activeSessions}`,
      );
      params.recordProcessed("completed", {
        reason: `acp_failover:${normalizeLowercaseStringOrEmpty(acpError.code)}`,
      });
      params.markIdle("message_completed");
      return failoverResult;
    }
    const delivered = await delivery.deliver("final", {
      text: formatAcpRuntimeErrorText(acpError),
      isError: true,
    });
    queuedFinal = queuedFinal || delivered;
    const counts = params.dispatcher.getQueuedCounts();
    delivery.applyRoutedCounts(counts);
    const acpStats = acpManager.getObservabilitySnapshot(params.cfg);
    const runId = normalizeOptionalString(params.runId);
    if (runId) {
      emitAgentEvent({
        runId,
        sessionKey,
        stream: "lifecycle",
        data: {
          phase: "error",
          startedAt: acpDispatchStartedAt,
          endedAt: Date.now(),
          error: acpError.message,
        },
      });
    }
    logVerbose(
      `acp-dispatch: session=${sessionKey} outcome=error code=${acpError.code} latencyMs=${Date.now() - acpDispatchStartedAt} queueDepth=${acpStats.turns.queueDepth} activeRuntimes=${acpStats.runtimeCache.activeSessions}`,
    );
    logAgentTurnLifecycle({
      phase: "turn_error",
      channel: normalizedDispatchChannel ?? "acp",
      accountId: effectiveDispatchAccountId,
      agentId: acpAgentId,
      sessionKey: canonicalSessionKey,
      requestId,
      runtime: "acp",
      elapsedMs: Date.now() - acpDispatchStartedAt,
      outcome: delivered ? "error_delivered" : "error_delivery_failed",
      error: acpError,
    });
    params.recordProcessed("completed", {
      reason: `acp_error:${normalizeLowercaseStringOrEmpty(acpError.code)}`,
    });
    params.markIdle("message_completed");
    return { queuedFinal, counts };
  }
}
