import type { StreamFn } from "@earendil-works/pi-agent-core";
import { fireAndForgetBoundedHook } from "../../../hooks/fire-and-forget.js";
import {
  diagnosticErrorCategory,
  diagnosticErrorFailureKind,
  diagnosticProviderRequestIdHash,
} from "../../../infra/diagnostic-error-metadata.js";
import {
  emitTrustedDiagnosticEvent,
  type DiagnosticEventInput,
  type DiagnosticMemoryUsage,
} from "../../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  formatDiagnosticTraceparent,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import type {
  PluginHookAgentContext,
  PluginHookContextWindowSource,
  PluginHookModelCallEndedEvent,
  PluginHookModelCallStartedEvent,
} from "../../../plugins/hook-types.js";

export { diagnosticErrorCategory };

type ModelCallDiagnosticContext = {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  provider: string;
  model: string;
  api?: string;
  transport?: string;
  contextTokenBudget?: number;
  contextWindowSource?: PluginHookContextWindowSource;
  contextWindowReferenceTokens?: number;
  trace: DiagnosticTraceContext;
  nextCallId: () => string;
  onStarted?: () => void;
};

type ModelCallEventBase = Omit<
  Extract<DiagnosticEventInput, { type: "model.call.started" }>,
  "type"
>;
type ModelCallErrorFields = Pick<
  Extract<DiagnosticEventInput, { type: "model.call.error" }>,
  "errorCategory" | "failureKind" | "memory" | "upstreamRequestIdHash"
>;
type ModelCallEndedHookFields = Pick<
  PluginHookModelCallEndedEvent,
  | "durationMs"
  | "outcome"
  | "errorCategory"
  | "requestPayloadBytes"
  | "responseStreamBytes"
  | "timeToFirstByteMs"
  | "failureKind"
  | "upstreamRequestIdHash"
>;
type ModelCallSizeTimingFields = Pick<
  Extract<DiagnosticEventInput, { type: "model.call.completed" }>,
  "requestPayloadBytes" | "responseStreamBytes" | "timeToFirstByteMs"
>;
type ModelCallObservationState = {
  requestPayloadBytes?: number;
  responseStreamBytes: number;
  timeToFirstByteMs?: number;
};

const MODEL_CALL_STREAM_RETURN_TIMEOUT_MS = 1000;
const EXACT_JSON_BYTE_LENGTH_LIMIT = 64 * 1024;
const ESTIMATED_JSON_MAX_DEPTH = 8;
const ESTIMATED_JSON_MAX_OBJECT_KEYS = 256;
const ESTIMATED_JSON_MAX_ARRAY_ITEMS = 512;
const ESTIMATED_JSON_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const TRACEPARENT_HEADER_NAME = "traceparent";
const RESPONSE_CHUNK_IGNORED_KEYS = new Set(["partial"]);
type ModelCallStreamOptions = Parameters<StreamFn>[2];

type JsonByteEstimate = {
  bytes: number;
  truncated: boolean;
};

type JsonByteEstimateOptions = {
  skipKeys?: ReadonlySet<string>;
};

function quotedStringUtf8JsonByteLength(value: string): number {
  if (value.length <= EXACT_JSON_BYTE_LENGTH_LIMIT) {
    try {
      return Buffer.byteLength(JSON.stringify(value), "utf8");
    } catch {
      return Buffer.byteLength(value, "utf8") + 2;
    }
  }
  let extraEscapes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      extraEscapes += 1;
    } else if (code < 0x20) {
      extraEscapes += 5;
    }
  }
  return Buffer.byteLength(value, "utf8") + extraEscapes + 2;
}

function estimateJsonByteLength(
  value: unknown,
  options: JsonByteEstimateOptions = {},
): JsonByteEstimate {
  const state = {
    seen: new WeakSet<object>(),
    bytes: 0,
    truncated: false,
  };
  const addBytes = (bytes: number) => {
    state.bytes += bytes;
    if (state.bytes > ESTIMATED_JSON_MAX_TOTAL_BYTES) {
      state.truncated = true;
    }
  };
  const addString = (text: string) => addBytes(quotedStringUtf8JsonByteLength(text));

  const visit = (current: unknown, depth: number): void => {
    if (state.truncated) {
      return;
    }
    if (current === null) {
      addBytes(4);
      return;
    }
    switch (typeof current) {
      case "string":
        addString(current);
        return;
      case "number":
        addBytes(Number.isFinite(current) ? String(current).length : 4);
        return;
      case "boolean":
        addBytes(current ? 4 : 5);
        return;
      case "bigint":
        addString(String(current));
        return;
      case "undefined":
      case "function":
      case "symbol":
        addBytes(0);
        return;
      default:
        break;
    }

    if (!current || typeof current !== "object") {
      addBytes(0);
      return;
    }
    if (depth >= ESTIMATED_JSON_MAX_DEPTH) {
      state.truncated = true;
      addString("[truncated]");
      return;
    }
    if (state.seen.has(current)) {
      addString("[circular]");
      return;
    }
    state.seen.add(current);

    if (Array.isArray(current)) {
      addBytes(1);
      const maxItems = Math.min(current.length, ESTIMATED_JSON_MAX_ARRAY_ITEMS);
      for (let index = 0; index < maxItems; index += 1) {
        if (index > 0) {
          addBytes(1);
        }
        const item = current[index];
        if (item === undefined || typeof item === "function" || typeof item === "symbol") {
          addBytes(4);
        } else {
          visit(item, depth + 1);
        }
        if (state.truncated) {
          break;
        }
      }
      if (current.length > maxItems) {
        state.truncated = true;
      }
      addBytes(1);
      state.seen.delete(current);
      return;
    }

    addBytes(1);
    let emitted = 0;
    let visited = 0;
    for (const key of Object.keys(current as Record<string, unknown>)) {
      if (options.skipKeys?.has(key)) {
        continue;
      }
      visited += 1;
      if (visited > ESTIMATED_JSON_MAX_OBJECT_KEYS) {
        state.truncated = true;
        break;
      }
      const child = (current as Record<string, unknown>)[key];
      if (child === undefined || typeof child === "function" || typeof child === "symbol") {
        continue;
      }
      if (emitted > 0) {
        addBytes(1);
      }
      addString(key);
      addBytes(1);
      visit(child, depth + 1);
      emitted += 1;
      if (state.truncated) {
        break;
      }
    }
    addBytes(1);
    state.seen.delete(current);
  };

  visit(value, 0);
  return { bytes: state.bytes, truncated: state.truncated };
}

function jsonByteLength(value: unknown, options?: JsonByteEstimateOptions): number | undefined {
  const estimate = estimateJsonByteLength(value, options);
  if (options?.skipKeys || estimate.truncated || estimate.bytes > EXACT_JSON_BYTE_LENGTH_LIMIT) {
    return estimate.bytes;
  }
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return estimate.bytes;
  }
}

function assignRequestPayloadBytes(state: ModelCallObservationState, payload: unknown): void {
  const bytes = jsonByteLength(payload);
  if (bytes !== undefined) {
    state.requestPayloadBytes = bytes;
  }
}

function responseChunkByteLength(chunk: unknown): number | undefined {
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
    return jsonByteLength(chunk);
  }
  return jsonByteLength(chunk, { skipKeys: RESPONSE_CHUNK_IGNORED_KEYS });
}

function observeResponseChunk(
  state: ModelCallObservationState,
  startedAt: number,
  chunk: unknown,
): void {
  state.timeToFirstByteMs ??= Math.max(0, Date.now() - startedAt);
  const bytes = responseChunkByteLength(chunk);
  if (bytes !== undefined) {
    state.responseStreamBytes += bytes;
  }
}

function modelCallSizeTimingFields(state: ModelCallObservationState): ModelCallSizeTimingFields {
  return {
    ...(state.requestPayloadBytes !== undefined
      ? { requestPayloadBytes: state.requestPayloadBytes }
      : {}),
    ...(state.responseStreamBytes > 0 ? { responseStreamBytes: state.responseStreamBytes } : {}),
    ...(state.timeToFirstByteMs !== undefined
      ? { timeToFirstByteMs: state.timeToFirstByteMs }
      : {}),
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return false;
  }
}

function asyncIteratorFactory(value: unknown): (() => AsyncIterator<unknown>) | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  try {
    const asyncIterator = (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
    if (typeof asyncIterator !== "function") {
      return undefined;
    }
    return () => asyncIterator.call(value) as AsyncIterator<unknown>;
  } catch {
    return undefined;
  }
}

function baseModelCallEvent(
  ctx: ModelCallDiagnosticContext,
  callId: string,
  trace: DiagnosticTraceContext,
): ModelCallEventBase {
  return {
    runId: ctx.runId,
    callId,
    ...(ctx.sessionKey && { sessionKey: ctx.sessionKey }),
    ...(ctx.sessionId && { sessionId: ctx.sessionId }),
    provider: ctx.provider,
    model: ctx.model,
    ...(ctx.api && { api: ctx.api }),
    ...(ctx.transport && { transport: ctx.transport }),
    ...(ctx.contextTokenBudget ? { contextTokenBudget: ctx.contextTokenBudget } : {}),
    ...(ctx.contextWindowSource ? { contextWindowSource: ctx.contextWindowSource } : {}),
    ...(ctx.contextWindowReferenceTokens
      ? { contextWindowReferenceTokens: ctx.contextWindowReferenceTokens }
      : {}),
    trace,
  };
}

function modelCallErrorFields(err: unknown): ModelCallErrorFields {
  const upstreamRequestIdHash = diagnosticProviderRequestIdHash(err);
  const failureKind = diagnosticErrorFailureKind(err);
  return {
    errorCategory: diagnosticErrorCategory(err),
    ...(failureKind ? { failureKind, memory: processMemoryUsageSnapshot() } : {}),
    ...(upstreamRequestIdHash ? { upstreamRequestIdHash } : {}),
  };
}

function processMemoryUsageSnapshot(): DiagnosticMemoryUsage | undefined {
  try {
    const memory = process.memoryUsage();
    return {
      rssBytes: memory.rss,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    };
  } catch {
    return undefined;
  }
}

function modelCallHookEventBase(eventBase: ModelCallEventBase): PluginHookModelCallStartedEvent {
  return {
    runId: eventBase.runId,
    callId: eventBase.callId,
    ...(eventBase.sessionKey ? { sessionKey: eventBase.sessionKey } : {}),
    ...(eventBase.sessionId ? { sessionId: eventBase.sessionId } : {}),
    provider: eventBase.provider,
    model: eventBase.model,
    ...(eventBase.api ? { api: eventBase.api } : {}),
    ...(eventBase.transport ? { transport: eventBase.transport } : {}),
    ...(eventBase.contextTokenBudget ? { contextTokenBudget: eventBase.contextTokenBudget } : {}),
    ...(eventBase.contextWindowSource
      ? { contextWindowSource: eventBase.contextWindowSource }
      : {}),
    ...(eventBase.contextWindowReferenceTokens
      ? { contextWindowReferenceTokens: eventBase.contextWindowReferenceTokens }
      : {}),
  };
}

function modelCallHookContext(eventBase: ModelCallEventBase): PluginHookAgentContext {
  return Object.freeze({
    runId: eventBase.runId,
    trace: eventBase.trace,
    ...(eventBase.sessionKey ? { sessionKey: eventBase.sessionKey } : {}),
    ...(eventBase.sessionId ? { sessionId: eventBase.sessionId } : {}),
    modelProviderId: eventBase.provider,
    modelId: eventBase.model,
    ...(eventBase.contextTokenBudget ? { contextTokenBudget: eventBase.contextTokenBudget } : {}),
    ...(eventBase.contextWindowSource
      ? { contextWindowSource: eventBase.contextWindowSource }
      : {}),
    ...(eventBase.contextWindowReferenceTokens
      ? { contextWindowReferenceTokens: eventBase.contextWindowReferenceTokens }
      : {}),
  }) as PluginHookAgentContext;
}

function dispatchModelCallStartedHook(eventBase: ModelCallEventBase): void {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("model_call_started")) {
    return;
  }
  const event = Object.freeze(modelCallHookEventBase(eventBase)) as PluginHookModelCallStartedEvent;
  const hookCtx = modelCallHookContext(eventBase);
  fireAndForgetBoundedHook(
    () => hookRunner.runModelCallStarted(event, hookCtx),
    "model_call_started plugin hook failed",
  );
}

function dispatchModelCallEndedHook(
  eventBase: ModelCallEventBase,
  fields: ModelCallEndedHookFields,
): void {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("model_call_ended")) {
    return;
  }
  const event = Object.freeze({
    ...modelCallHookEventBase(eventBase),
    ...fields,
  }) as PluginHookModelCallEndedEvent;
  const hookCtx = modelCallHookContext(eventBase);
  fireAndForgetBoundedHook(
    () => hookRunner.runModelCallEnded(event, hookCtx),
    "model_call_ended plugin hook failed",
  );
}

function emitModelCallStarted(eventBase: ModelCallEventBase): void {
  emitTrustedDiagnosticEvent({
    type: "model.call.started",
    ...eventBase,
  });
  dispatchModelCallStartedHook(eventBase);
}

function emitModelCallCompleted(
  eventBase: ModelCallEventBase,
  startedAt: number,
  state: ModelCallObservationState,
): void {
  const durationMs = Date.now() - startedAt;
  const sizeTimingFields = modelCallSizeTimingFields(state);
  emitTrustedDiagnosticEvent({
    type: "model.call.completed",
    ...eventBase,
    durationMs,
    ...sizeTimingFields,
  });
  dispatchModelCallEndedHook(eventBase, {
    durationMs,
    outcome: "completed",
    ...sizeTimingFields,
  });
}

function emitModelCallError(
  eventBase: ModelCallEventBase,
  startedAt: number,
  state: ModelCallObservationState,
  fields: ModelCallErrorFields,
): void {
  const durationMs = Date.now() - startedAt;
  const sizeTimingFields = modelCallSizeTimingFields(state);
  emitTrustedDiagnosticEvent({
    type: "model.call.error",
    ...eventBase,
    durationMs,
    ...sizeTimingFields,
    ...fields,
  });
  dispatchModelCallEndedHook(eventBase, {
    durationMs,
    outcome: "error",
    ...sizeTimingFields,
    ...fields,
  });
}

function withDiagnosticTraceparentHeader(
  options: ModelCallStreamOptions,
  trace: DiagnosticTraceContext,
  state: ModelCallObservationState,
): ModelCallStreamOptions {
  const traceparent = formatDiagnosticTraceparent(trace);
  const originalOnPayload = options?.onPayload;
  const onPayload: NonNullable<ModelCallStreamOptions>["onPayload"] = (payload, model) => {
    if (!originalOnPayload) {
      assignRequestPayloadBytes(state, payload);
      return undefined;
    }
    const result = originalOnPayload(payload, model);
    if (isPromiseLike(result)) {
      return result.then((replacement) => {
        assignRequestPayloadBytes(state, replacement ?? payload);
        return replacement;
      });
    }
    assignRequestPayloadBytes(state, result ?? payload);
    return result;
  };

  if (!traceparent) {
    return {
      ...options,
      onPayload,
    };
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(options?.headers ?? {})) {
    if (key.toLowerCase() === TRACEPARENT_HEADER_NAME) {
      continue;
    }
    headers[key] = value;
  }
  headers[TRACEPARENT_HEADER_NAME] = traceparent;
  return {
    ...options,
    headers,
    onPayload,
  };
}

async function safeReturnIterator(iterator: AsyncIterator<unknown>): Promise<void> {
  let returnResult: unknown;
  try {
    returnResult = iterator.return?.();
  } catch {
    return;
  }
  if (!returnResult) {
    return;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(returnResult).catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, MODEL_CALL_STREAM_RETURN_TIMEOUT_MS);
        const unref =
          typeof timeout === "object" && timeout
            ? (timeout as { unref?: () => void }).unref
            : undefined;
        if (unref) {
          unref.call(timeout);
        }
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function* observeModelCallIterator<T>(
  iterator: AsyncIterator<T>,
  eventBase: ModelCallEventBase,
  startedAt: number,
  state: ModelCallObservationState,
): AsyncIterable<T> {
  let terminalEmitted = false;
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      observeResponseChunk(state, startedAt, next.value);
      yield next.value;
    }
    terminalEmitted = true;
    emitModelCallCompleted(eventBase, startedAt, state);
  } catch (err) {
    terminalEmitted = true;
    emitModelCallError(eventBase, startedAt, state, modelCallErrorFields(err));
    throw err;
  } finally {
    if (!terminalEmitted) {
      await safeReturnIterator(iterator);
      emitModelCallCompleted(eventBase, startedAt, state);
    }
  }
}

function observeModelCallStream<T extends AsyncIterable<unknown>>(
  stream: T,
  createIterator: () => AsyncIterator<unknown>,
  eventBase: ModelCallEventBase,
  startedAt: number,
  state: ModelCallObservationState,
): T {
  const observedIterator = () =>
    observeModelCallIterator(createIterator(), eventBase, startedAt, state)[Symbol.asyncIterator]();
  let hasNonConfigurableIterator = false;
  try {
    hasNonConfigurableIterator =
      Object.getOwnPropertyDescriptor(stream, Symbol.asyncIterator)?.configurable === false;
  } catch {
    hasNonConfigurableIterator = true;
  }
  if (hasNonConfigurableIterator) {
    return {
      [Symbol.asyncIterator]: observedIterator,
    } as T;
  }
  return new Proxy(stream, {
    get(target, property, receiver) {
      if (property === Symbol.asyncIterator) {
        return observedIterator;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function observeModelCallResult(
  result: unknown,
  eventBase: ModelCallEventBase,
  startedAt: number,
  state: ModelCallObservationState,
): unknown {
  const createIterator = asyncIteratorFactory(result);
  if (createIterator) {
    return observeModelCallStream(
      result as AsyncIterable<unknown>,
      createIterator,
      eventBase,
      startedAt,
      state,
    );
  }
  emitModelCallCompleted(eventBase, startedAt, state);
  return result;
}

export function wrapStreamFnWithDiagnosticModelCallEvents(
  streamFn: StreamFn,
  ctx: ModelCallDiagnosticContext,
): StreamFn {
  return ((model, streamContext, options) => {
    const callId = ctx.nextCallId();
    const trace = freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(ctx.trace));
    const eventBase = baseModelCallEvent(ctx, callId, trace);
    emitModelCallStarted(eventBase);
    ctx.onStarted?.();
    const startedAt = Date.now();
    const state: ModelCallObservationState = { responseStreamBytes: 0 };
    const propagatedOptions = withDiagnosticTraceparentHeader(options, trace, state);

    try {
      const result = streamFn(model, streamContext, propagatedOptions);
      if (isPromiseLike(result)) {
        return result.then(
          (resolved) => observeModelCallResult(resolved, eventBase, startedAt, state),
          (err) => {
            emitModelCallError(eventBase, startedAt, state, modelCallErrorFields(err));
            throw err;
          },
        );
      }
      return observeModelCallResult(result, eventBase, startedAt, state);
    } catch (err) {
      emitModelCallError(eventBase, startedAt, state, modelCallErrorFields(err));
      throw err;
    }
  }) as StreamFn;
}
