import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatErrorMessage } from "./errors.js";

export type AgentTurnLifecyclePhase =
  | "received"
  | "reply_lifecycle_started"
  | "prompt_submitted"
  | "first_output"
  | "final_delivery_started"
  | "final_delivery_done"
  | "turn_done"
  | "turn_error"
  | "silent_fallback";

export type AgentTurnLifecycleEvent = {
  phase: AgentTurnLifecyclePhase;
  channel: string;
  accountId?: string;
  agentId?: string;
  sessionKey?: string;
  requestId?: string;
  originalRequestId?: string;
  failoverRequestId?: string;
  failoverSessionKey?: string;
  failoverAgentId?: string;
  runtime?: string;
  elapsedMs?: number;
  outcome?: string;
  error?: unknown;
};

const log = createSubsystemLogger("agent/turn-lifecycle");

function normalizeField(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function formatLifecycleEvent(event: AgentTurnLifecycleEvent): string {
  const parts = [
    "agent turn lifecycle",
    `phase=${event.phase}`,
    `channel=${event.channel}`,
    event.accountId ? `accountId=${event.accountId}` : undefined,
    event.agentId ? `agentId=${event.agentId}` : undefined,
    event.sessionKey ? `sessionKey=${event.sessionKey}` : undefined,
    event.requestId ? `requestId=${event.requestId}` : undefined,
    event.originalRequestId ? `originalRequestId=${event.originalRequestId}` : undefined,
    event.failoverRequestId ? `failoverRequestId=${event.failoverRequestId}` : undefined,
    event.failoverSessionKey ? `failoverSessionKey=${event.failoverSessionKey}` : undefined,
    event.failoverAgentId ? `failoverAgentId=${event.failoverAgentId}` : undefined,
    event.runtime ? `runtime=${event.runtime}` : undefined,
    typeof event.elapsedMs === "number"
      ? `elapsedMs=${Math.max(0, Math.round(event.elapsedMs))}`
      : undefined,
    event.outcome ? `outcome=${event.outcome}` : undefined,
    event.error ? `error=${redactSensitiveText(formatErrorMessage(event.error))}` : undefined,
  ];
  return parts.filter(Boolean).join(" ");
}

export function logAgentTurnLifecycle(event: AgentTurnLifecycleEvent): void {
  log.info(
    formatLifecycleEvent({
      ...event,
      accountId: normalizeField(event.accountId),
      agentId: normalizeField(event.agentId),
      sessionKey: normalizeField(event.sessionKey),
      requestId: normalizeField(event.requestId),
      originalRequestId: normalizeField(event.originalRequestId),
      failoverRequestId: normalizeField(event.failoverRequestId),
      failoverSessionKey: normalizeField(event.failoverSessionKey),
      failoverAgentId: normalizeField(event.failoverAgentId),
      runtime: normalizeField(event.runtime),
      outcome: normalizeField(event.outcome),
    }),
  );
}
