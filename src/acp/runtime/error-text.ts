import { type AcpRuntimeErrorCode, AcpRuntimeError, toAcpRuntimeError } from "./errors.js";
import { classifyAcpTransientTransportErrorText } from "./transport-errors.js";

function resolveAcpRuntimeErrorNextStep(error: AcpRuntimeError): string | undefined {
  if (error.code === "ACP_BACKEND_MISSING" || error.code === "ACP_BACKEND_UNAVAILABLE") {
    return "Run `/acp doctor`, install/enable the backend plugin, then retry.";
  }
  if (error.code === "ACP_DISPATCH_DISABLED") {
    return "Enable `acp.dispatch.enabled=true` to allow thread-message ACP turns.";
  }
  if (error.code === "ACP_SESSION_INIT_FAILED") {
    return "If this session is stale, recreate it with `/acp spawn` and rebind the thread.";
  }
  if (error.code === "ACP_INVALID_RUNTIME_OPTION") {
    return "Use `/acp status` to inspect options and pass valid values.";
  }
  if (error.code === "ACP_BACKEND_UNSUPPORTED_CONTROL") {
    return "This backend does not support that control; use a supported command.";
  }
  if (error.code === "ACP_TURN_FAILED") {
    return "Retry, or use `/acp cancel` and send the message again.";
  }
  return undefined;
}

function formatTransientTurnFailure(error: AcpRuntimeError): string | null {
  if (error.code !== "ACP_TURN_FAILED") {
    return null;
  }
  const transportError = classifyAcpTransientTransportErrorText(error.message);
  if (!transportError) {
    return null;
  }
  return [
    `ACP error (${error.code}): ACP turn was interrupted by a transient network/provider stream disconnect.`,
    `detail: ${transportError.summary}.`,
    "I did not drop this message; the ACP binding is still active.",
    "next: Retry shortly. If this repeats, switch model or recreate the ACP worker, then run `openclaw agent-quality check --since-minutes 15`.",
  ].join("\n");
}

export function formatAcpRuntimeErrorText(error: AcpRuntimeError): string {
  const transientTurnFailure = formatTransientTurnFailure(error);
  if (transientTurnFailure) {
    return transientTurnFailure;
  }
  const next = resolveAcpRuntimeErrorNextStep(error);
  if (!next) {
    return `ACP error (${error.code}): ${error.message}`;
  }
  return `ACP error (${error.code}): ${error.message}\nnext: ${next}`;
}

export function toAcpRuntimeErrorText(params: {
  error: unknown;
  fallbackCode: AcpRuntimeErrorCode;
  fallbackMessage: string;
}): string {
  return formatAcpRuntimeErrorText(
    toAcpRuntimeError({
      error: params.error,
      fallbackCode: params.fallbackCode,
      fallbackMessage: params.fallbackMessage,
    }),
  );
}
