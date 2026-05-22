import type { AcpRuntimeEvent, AcpSessionUpdateTag } from "../../acp/runtime/types.js";
import { EmbeddedBlockChunker } from "../../agents/pi-embedded-block-chunker.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prefixSystemMessage } from "../../infra/system-message.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import type { ReplyPayload } from "../types.js";
import {
  type AcpHiddenBoundarySeparator,
  isAcpTagVisible,
  resolveAcpProjectionSettings,
  resolveAcpStreamingConfig,
} from "./acp-stream-settings.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";

const ACP_BLOCK_REPLY_TIMEOUT_MS = 15_000;
const ACP_LIVE_IDLE_FLUSH_FLOOR_MS = 750;
const ACP_LIVE_IDLE_MIN_CHARS = 80;
const ACP_LIVE_SOFT_FLUSH_CHARS = 220;
const ACP_LIVE_HARD_FLUSH_CHARS = 480;

const TERMINAL_TOOL_STATUSES = new Set(["completed", "failed", "cancelled", "done", "error"]);
const FAILED_TOOL_STATUSES = new Set(["failed", "cancelled", "error"]);
const HIDDEN_BOUNDARY_TAGS = new Set<AcpSessionUpdateTag>(["tool_call", "tool_call_update"]);
const SUCCESS_CLAIM_PATTERN =
  /(已验证|验证通过|通过验证|成功|verified|passed|validation passed|confirmed)/iu;
const MEDIA_REFERENCE_PATTERN = /\bMEDIA:\s*\S+/iu;
const RAW_VISIBLE_ERROR_PATTERNS = [
  /"error"\s*:\s*"(?:EPERM|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EACCES)"/iu,
  /\b(?:connect|request|fetch)\s+(?:EPERM|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EACCES)\b/iu,
  /\bSSL routines\b/iu,
  /\btls_get_more_records\b/iu,
  /\bbad record mac\b/iu,
  /\berror:.*\bopenssl\b/iu,
  /\bopenssl\b.*\berror:/iu,
  /\[internal\].*\berror:/iu,
] as const;

const PAGE_VALIDATION_CONTEXT_PATTERNS = [
  /\bFY TARGET\b/iu,
  /\bYTD BUDGET\b/iu,
  /\bpage\b/iu,
  /页面/iu,
  /验证/iu,
  /https?:\/\//iu,
] as const;

export type AcpProjectedDeliveryMeta = {
  tag?: AcpSessionUpdateTag;
  toolCallId?: string;
  toolStatus?: string;
  allowEdit?: boolean;
};

type ToolLifecycleState = {
  started: boolean;
  terminal: boolean;
  lastRenderedHash?: string;
};

type BufferedToolDelivery = {
  payload: ReplyPayload;
  meta?: AcpProjectedDeliveryMeta;
};

function truncateText(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  if (maxChars <= 1) {
    return input.slice(0, maxChars);
  }
  return `${input.slice(0, maxChars - 1)}…`;
}

function hashText(text: string): string {
  return text.trim();
}

function normalizeToolStatus(status: string | undefined): string | undefined {
  const normalized = normalizeOptionalLowercaseString(status);
  return normalized || undefined;
}

function containsMediaReference(input: string): boolean {
  return MEDIA_REFERENCE_PATTERN.test(input);
}

function looksLikeRawVisibleError(input: string): boolean {
  return includesAny(input, RAW_VISIBLE_ERROR_PATTERNS);
}

function looksLikePageValidationContext(input: string): boolean {
  return (
    countMatches(input, /(?:FY TARGET|YTD BUDGET|页面|验证|page|https?:\/\/)/giu) >= 2 ||
    includesAny(input, PAGE_VALIDATION_CONTEXT_PATTERNS)
  );
}

function sanitizeVisibleAssistantText(input: string): string {
  if (!looksLikeRawVisibleError(input)) {
    return input;
  }
  if (looksLikePageValidationContext(input)) {
    return "⚠️ Page validation failed: could not connect to the target address, so the target content could not be confirmed.";
  }
  if (/\bSSL routines\b|\btls_get_more_records\b|\bbad record mac\b|\bopenssl\b/iu.test(input)) {
    return "⚠️ Validation failed: a network or secure connection error prevented the check.";
  }
  if (
    /\b(?:connect|request|fetch)\s+(?:EPERM|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EACCES)\b/iu.test(
      input,
    )
  ) {
    return "⚠️ Validation failed: could not connect to the target address.";
  }
  return "⚠️ Tool execution failed. Check the verification log or retry.";
}

function includesAny(input: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(input));
}

function countMatches(input: string, pattern: RegExp): number {
  return Array.from(input.matchAll(pattern)).length;
}

function isInternalToolBreadcrumb(input: string): boolean {
  return (
    input.includes("→") ||
    countMatches(input, /\brun\s+/giu) >= 3 ||
    includesAny(input, [
      /\bheredoc\b/iu,
      /\binline script\b/iu,
      /\bconst\s+(?:browser|context|page|text|checks)\b/iu,
      /\bpage\.on\s*\(/iu,
      /\bconsole\.log\s*\(/iu,
      /\btext\.includes\s*\(/iu,
      /\b(?:node|python3?|ruby|php)\s+\([^)]*\)\s+failed\b/iu,
    ])
  );
}

function classifyToolSummary(event: Extract<AcpRuntimeEvent, { type: "tool_call" }>): {
  action:
    | "page_validation"
    | "script"
    | "test"
    | "build"
    | "git"
    | "openclaw"
    | "file_read"
    | "file_write"
    | "file_edit"
    | "tool";
  internal: boolean;
} {
  const title = normalizeOptionalString(event.title);
  const text = normalizeOptionalString(event.text);
  const combined = `${title}\n${text}`;
  const lower = combined.toLowerCase();
  const internal = isInternalToolBreadcrumb(combined);
  const isInlineScript = /\b(?:node|python3?|ruby|php)\b.*\b(?:inline script|heredoc)\b/iu.test(
    combined,
  );
  const isScriptFailure = /\b(?:node|python3?|ruby|php)\s+\([^)]*\)\s+failed\b/iu.test(combined);
  const looksLikePageValidation =
    (isInlineScript || isScriptFailure || /\bbrowser\b|\bplaywright\b|\bpage\b/iu.test(combined)) &&
    includesAny(combined, [
      /\bbrowser\b/iu,
      /\bplaywright\b/iu,
      /\bpage\b/iu,
      /\btext\.includes\s*\(/iu,
      /\bfy target\b/iu,
      /\bytd budget\b/iu,
    ]);

  if (looksLikePageValidation) {
    return { action: "page_validation", internal };
  }
  if (isInlineScript || isScriptFailure) {
    return { action: "script", internal };
  }
  if (/\b(?:pnpm|npm|yarn|bun)\b.*\btest\b|\brun(?:ning)? tests?\b|\btests?\b/iu.test(lower)) {
    return { action: "test", internal };
  }
  if (/\b(?:pnpm|npm|yarn|bun)\b.*\bbuild\b|\brun(?:ning)? builds?\b|\bbuild\b/iu.test(lower)) {
    return { action: "build", internal };
  }
  if (/\bgit\b/iu.test(lower)) {
    return { action: "git", internal };
  }
  if (/\bread\s+files?\b|\bread\b.*\bfiles?\b|\bfile\s+read\b/iu.test(lower)) {
    return { action: "file_read", internal };
  }
  if (/\bwrite\s+files?\b|\bwrite\b.*\bfiles?\b|\bfile\s+write\b/iu.test(lower)) {
    return { action: "file_write", internal };
  }
  if (/\bedit\s+files?\b|\bedit\b.*\bfiles?\b|\bfile\s+edit\b/iu.test(lower)) {
    return { action: "file_edit", internal };
  }
  if (/\bopenclaw\b/iu.test(lower)) {
    return { action: "openclaw", internal };
  }
  return { action: "tool", internal };
}

function renderClassifiedToolSummary(params: {
  action: ReturnType<typeof classifyToolSummary>["action"];
  status?: string;
  successClaimSeen: boolean;
}): string {
  const failed = params.status ? FAILED_TOOL_STATUSES.has(params.status) : false;
  const completed =
    params.status === "completed" || params.status === "done" || params.status === "success";

  if (failed && params.successClaimSeen && params.action === "page_validation") {
    return "⚠️ Validation not confirmed: a later page validation failed, so the earlier success claim needs another check.";
  }

  if (params.action === "page_validation") {
    if (failed) {
      return "⚠️ Page validation failed: could not confirm the target content appeared.";
    }
    if (completed) {
      return "✅ Page validation completed.";
    }
    return "🛠️ Validating page.";
  }

  if (params.action === "script") {
    if (failed) {
      return "⚠️ Script execution failed. Check the verification log or retry.";
    }
    if (completed) {
      return "✅ Script execution completed.";
    }
    return "🛠️ Running script.";
  }

  if (params.action === "test") {
    if (failed) {
      return "⚠️ Tests failed.";
    }
    if (completed) {
      return "✅ Tests completed.";
    }
    return "🛠️ Running tests.";
  }

  if (params.action === "build") {
    if (failed) {
      return "⚠️ Build failed.";
    }
    if (completed) {
      return "✅ Build completed.";
    }
    return "🛠️ Running build.";
  }

  if (params.action === "git") {
    if (failed) {
      return "⚠️ Git operation failed.";
    }
    if (completed) {
      return "✅ Git operation completed.";
    }
    return "🛠️ Running Git operation.";
  }

  if (params.action === "openclaw") {
    if (failed) {
      return "⚠️ OpenClaw check failed.";
    }
    if (completed) {
      return "✅ OpenClaw check completed.";
    }
    return "🛠️ Running OpenClaw check.";
  }

  if (params.action === "file_read") {
    if (failed) {
      return "⚠️ File read failed.";
    }
    if (completed) {
      return "✅ Finished reading files.";
    }
    return "🛠️ Reading files.";
  }

  if (params.action === "file_write") {
    if (failed) {
      return "⚠️ File write failed.";
    }
    if (completed) {
      return "✅ Finished writing files.";
    }
    return "🛠️ Writing files.";
  }

  if (params.action === "file_edit") {
    if (failed) {
      return "⚠️ File edit failed.";
    }
    if (completed) {
      return "✅ Finished editing files.";
    }
    return "🛠️ Editing files.";
  }

  if (failed) {
    return "⚠️ Tool execution failed.";
  }
  if (completed) {
    return "✅ Tool execution completed.";
  }
  return "🛠️ Running tool.";
}

function resolveHiddenBoundarySeparatorText(mode: AcpHiddenBoundarySeparator): string {
  if (mode === "space") {
    return " ";
  }
  if (mode === "newline") {
    return "\n";
  }
  if (mode === "paragraph") {
    return "\n\n";
  }
  return "";
}

function shouldInsertSeparator(params: {
  separator: string;
  previousTail: string | undefined;
  nextText: string;
}): boolean {
  if (!params.separator) {
    return false;
  }
  if (!params.nextText) {
    return false;
  }
  const firstChar = params.nextText[0];
  if (typeof firstChar === "string" && /\s/.test(firstChar)) {
    return false;
  }
  const tail = params.previousTail ?? "";
  if (!tail) {
    return false;
  }
  if (params.separator === " " && /\s$/.test(tail)) {
    return false;
  }
  if ((params.separator === "\n" || params.separator === "\n\n") && tail.endsWith("\n")) {
    return false;
  }
  return true;
}

function shouldFlushLiveBufferOnBoundary(text: string): boolean {
  if (!text) {
    return false;
  }
  if (text.length >= ACP_LIVE_HARD_FLUSH_CHARS) {
    return true;
  }
  if (text.endsWith("\n\n")) {
    return true;
  }
  if (/[.!?][)"'`]*\s$/.test(text)) {
    return true;
  }
  if (text.length >= ACP_LIVE_SOFT_FLUSH_CHARS && /\s$/.test(text)) {
    return true;
  }
  return false;
}

function shouldFlushLiveBufferOnIdle(text: string): boolean {
  if (!text) {
    return false;
  }
  if (text.length >= ACP_LIVE_IDLE_MIN_CHARS) {
    return true;
  }
  if (/[.!?][)"'`]*$/.test(text.trimEnd())) {
    return true;
  }
  if (text.includes("\n")) {
    return true;
  }
  return false;
}

function renderToolSummaryText(
  event: Extract<AcpRuntimeEvent, { type: "tool_call" }>,
  opts: { successClaimSeen: boolean },
): string {
  const status = normalizeToolStatus(event.status);
  const classification = classifyToolSummary(event);
  return renderClassifiedToolSummary({
    action: classification.action,
    status,
    successClaimSeen: opts.successClaimSeen,
  });
}

export type AcpReplyProjector = {
  onEvent: (event: AcpRuntimeEvent) => Promise<void>;
  flush: (force?: boolean) => Promise<void>;
};

export function createAcpReplyProjector(params: {
  cfg: OpenClawConfig;
  shouldSendToolSummaries: boolean;
  deliver: (
    kind: ReplyDispatchKind,
    payload: ReplyPayload,
    meta?: AcpProjectedDeliveryMeta,
  ) => Promise<boolean>;
  onProgress?: () => void;
  provider?: string;
  accountId?: string;
}): AcpReplyProjector {
  const settings = resolveAcpProjectionSettings(params.cfg);
  const streaming = resolveAcpStreamingConfig({
    cfg: params.cfg,
    provider: params.provider,
    accountId: params.accountId,
    deliveryMode: settings.deliveryMode,
  });
  const createTurnBlockReplyPipeline = () =>
    createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        await params.deliver("block", payload);
      },
      timeoutMs: ACP_BLOCK_REPLY_TIMEOUT_MS,
      coalescing: settings.deliveryMode === "live" ? undefined : streaming.coalescing,
    });
  let blockReplyPipeline = createTurnBlockReplyPipeline();
  const chunker = new EmbeddedBlockChunker(streaming.chunking);
  const liveIdleFlushMs = Math.max(streaming.coalescing.idleMs, ACP_LIVE_IDLE_FLUSH_FLOOR_MS);

  let emittedOutputChars = 0;
  let truncationNoticeEmitted = false;
  let lastStatusHash: string | undefined;
  let lastToolHash: string | undefined;
  let lastUsageTuple: string | undefined;
  let lastVisibleOutputTail: string | undefined;
  let pendingHiddenBoundary = false;
  let liveBufferText = "";
  let finalOnlyOutputText = "";
  let liveIdleTimer: NodeJS.Timeout | undefined;
  let successClaimSeen = false;
  const pendingToolDeliveries: BufferedToolDelivery[] = [];
  const toolLifecycleById = new Map<string, ToolLifecycleState>();

  const clearLiveIdleTimer = () => {
    if (!liveIdleTimer) {
      return;
    }
    clearTimeout(liveIdleTimer);
    liveIdleTimer = undefined;
  };

  const drainChunker = (force: boolean) => {
    if (settings.deliveryMode === "final_only" && !force) {
      return;
    }
    chunker.drain({
      force,
      emit: (chunk) => {
        blockReplyPipeline.enqueue({ text: chunk });
      },
    });
  };

  const flushLiveBuffer = (opts?: { force?: boolean; idle?: boolean }) => {
    if (settings.deliveryMode !== "live") {
      return;
    }
    if (!liveBufferText) {
      return;
    }
    if (opts?.idle && !shouldFlushLiveBufferOnIdle(liveBufferText)) {
      return;
    }
    const text = liveBufferText;
    liveBufferText = "";
    chunker.append(text);
    drainChunker(opts?.force === true);
  };

  const scheduleLiveIdleFlush = () => {
    if (settings.deliveryMode !== "live") {
      return;
    }
    if (liveIdleFlushMs <= 0 || !liveBufferText) {
      return;
    }
    clearLiveIdleTimer();
    liveIdleTimer = setTimeout(() => {
      flushLiveBuffer({ force: true, idle: true });
      if (liveBufferText) {
        scheduleLiveIdleFlush();
      }
    }, liveIdleFlushMs);
  };

  const resetTurnState = () => {
    clearLiveIdleTimer();
    blockReplyPipeline.stop();
    blockReplyPipeline = createTurnBlockReplyPipeline();
    emittedOutputChars = 0;
    truncationNoticeEmitted = false;
    lastStatusHash = undefined;
    lastToolHash = undefined;
    lastUsageTuple = undefined;
    lastVisibleOutputTail = undefined;
    pendingHiddenBoundary = false;
    liveBufferText = "";
    finalOnlyOutputText = "";
    pendingToolDeliveries.length = 0;
    successClaimSeen = false;
    toolLifecycleById.clear();
  };

  const flushBufferedToolDeliveries = async (force: boolean) => {
    if (!(settings.deliveryMode === "final_only" && force)) {
      return;
    }
    for (const entry of pendingToolDeliveries.splice(0)) {
      await params.deliver("tool", entry.payload, entry.meta);
    }
  };

  const flush = async (force = false): Promise<void> => {
    if (settings.deliveryMode === "live") {
      clearLiveIdleTimer();
      flushLiveBuffer({ force: true });
    }
    await flushBufferedToolDeliveries(force);
    if (settings.deliveryMode === "final_only") {
      if (force && finalOnlyOutputText.trim().length > 0) {
        const text = finalOnlyOutputText;
        finalOnlyOutputText = "";
        await params.deliver("final", { text });
      }
    } else {
      drainChunker(force);
    }
    await blockReplyPipeline.flush({ force });
  };

  const emitSystemStatus = async (
    text: string,
    meta?: AcpProjectedDeliveryMeta,
    opts?: { dedupe?: boolean },
  ) => {
    if (!params.shouldSendToolSummaries) {
      return;
    }
    const bounded = truncateText(text.trim(), settings.maxSessionUpdateChars);
    if (!bounded) {
      return;
    }
    const formatted = prefixSystemMessage(bounded);
    const hash = hashText(formatted);
    const shouldDedupe = settings.repeatSuppression && opts?.dedupe !== false;
    if (shouldDedupe && lastStatusHash === hash) {
      return;
    }
    if (settings.deliveryMode === "final_only") {
      pendingToolDeliveries.push({
        payload: { text: formatted },
        meta,
      });
    } else {
      await flush(true);
      await params.deliver("tool", { text: formatted }, meta);
    }
    lastStatusHash = hash;
  };

  const emitToolSummary = async (
    event: Extract<AcpRuntimeEvent, { type: "tool_call" }>,
    opts?: { forceVisible?: boolean },
  ) => {
    if (!params.shouldSendToolSummaries) {
      return;
    }
    if (!opts?.forceVisible && !isAcpTagVisible(settings, event.tag)) {
      return;
    }

    const renderedToolSummary = renderToolSummaryText(event, { successClaimSeen });
    const toolSummary = truncateText(renderedToolSummary, settings.maxSessionUpdateChars);
    const hash = hashText(renderedToolSummary);
    const toolCallId = normalizeOptionalString(event.toolCallId);
    const status = normalizeToolStatus(event.status);
    const isTerminal = status ? TERMINAL_TOOL_STATUSES.has(status) : false;
    const isStart = status === "in_progress" || event.tag === "tool_call";

    if (settings.repeatSuppression) {
      if (toolCallId) {
        const state = toolLifecycleById.get(toolCallId) ?? {
          started: false,
          terminal: false,
        };
        if (isTerminal && state.terminal) {
          return;
        }
        if (isStart && state.started) {
          return;
        }
        if (state.lastRenderedHash === hash) {
          return;
        }
        if (isStart) {
          state.started = true;
        }
        if (isTerminal) {
          state.terminal = true;
        }
        state.lastRenderedHash = hash;
        toolLifecycleById.set(toolCallId, state);
      } else if (lastToolHash === hash) {
        return;
      }
    }

    const deliveryMeta: AcpProjectedDeliveryMeta = {
      ...(event.tag ? { tag: event.tag } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(status ? { toolStatus: status } : {}),
      allowEdit: Boolean(toolCallId && event.tag === "tool_call_update"),
    };
    if (settings.deliveryMode === "final_only") {
      pendingToolDeliveries.push({
        payload: { text: toolSummary },
        meta: deliveryMeta,
      });
    } else {
      await flush(true);
      await params.deliver("tool", { text: toolSummary }, deliveryMeta);
    }
    lastToolHash = hash;
  };

  const emitTruncationNotice = async () => {
    if (truncationNoticeEmitted) {
      return;
    }
    truncationNoticeEmitted = true;
    await emitSystemStatus(
      "output truncated",
      {
        tag: "session_info_update",
      },
      {
        dedupe: false,
      },
    );
  };

  const onEvent = async (event: AcpRuntimeEvent): Promise<void> => {
    params.onProgress?.();
    if (event.type === "text_delta") {
      if (event.stream && event.stream !== "output") {
        return;
      }
      if (!isAcpTagVisible(settings, event.tag)) {
        return;
      }
      let text = event.text;
      if (!text) {
        return;
      }
      text = sanitizeVisibleAssistantText(text);
      if (
        pendingHiddenBoundary &&
        shouldInsertSeparator({
          separator: resolveHiddenBoundarySeparatorText(settings.hiddenBoundarySeparator),
          previousTail: lastVisibleOutputTail,
          nextText: text,
        })
      ) {
        text = `${resolveHiddenBoundarySeparatorText(settings.hiddenBoundarySeparator)}${text}`;
      }
      pendingHiddenBoundary = false;
      if (emittedOutputChars >= settings.maxOutputChars) {
        await emitTruncationNotice();
        return;
      }
      const remaining = settings.maxOutputChars - emittedOutputChars;
      const accepted = remaining < text.length ? text.slice(0, remaining) : text;
      if (accepted.length > 0) {
        if (SUCCESS_CLAIM_PATTERN.test(accepted)) {
          successClaimSeen = true;
        }
        emittedOutputChars += accepted.length;
        lastVisibleOutputTail = accepted.slice(-1);
        if (settings.deliveryMode === "live") {
          if (containsMediaReference(accepted)) {
            clearLiveIdleTimer();
            flushLiveBuffer({ force: true });
            await flush(true);
            await params.deliver("final", { text: accepted });
            return;
          }
          liveBufferText += accepted;
          if (shouldFlushLiveBufferOnBoundary(liveBufferText)) {
            clearLiveIdleTimer();
            flushLiveBuffer({ force: true });
          } else {
            scheduleLiveIdleFlush();
          }
        } else {
          finalOnlyOutputText += accepted;
        }
      }
      if (accepted.length < text.length) {
        await emitTruncationNotice();
      }
      return;
    }

    if (event.type === "status") {
      if (!isAcpTagVisible(settings, event.tag)) {
        return;
      }
      if (event.tag === "usage_update" && settings.repeatSuppression) {
        const usageTuple =
          typeof event.used === "number" && typeof event.size === "number"
            ? `${event.used}/${event.size}`
            : hashText(event.text);
        if (usageTuple === lastUsageTuple) {
          return;
        }
        lastUsageTuple = usageTuple;
      }
      await emitSystemStatus(event.text, event.tag ? { tag: event.tag } : undefined, {
        dedupe: true,
      });
      return;
    }

    if (event.type === "tool_call") {
      if (!isAcpTagVisible(settings, event.tag)) {
        const toolCallId = normalizeOptionalString(event.toolCallId);
        const status = normalizeToolStatus(event.status);
        const isTerminal = status ? TERMINAL_TOOL_STATUSES.has(status) : false;
        if (isTerminal && toolCallId && toolLifecycleById.get(toolCallId)?.started) {
          await emitToolSummary(event, { forceVisible: true });
          return;
        }
        if (event.tag && HIDDEN_BOUNDARY_TAGS.has(event.tag)) {
          pendingHiddenBoundary = pendingHiddenBoundary || event.tag === "tool_call" || isTerminal;
        }
        return;
      }
      await emitToolSummary(event);
      return;
    }

    if (event.type === "done" || event.type === "error") {
      await flush(true);
      resetTurnState();
    }
  };

  return {
    onEvent,
    flush,
  };
}
