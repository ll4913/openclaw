export type AcpTransientTransportErrorKind =
  | "provider_stream_disconnected"
  | "acp_session_stream_closed"
  | "socket_reset"
  | "provider_fetch_failed"
  | "telegram_transport_socket";

export type AcpTransientTransportError = {
  kind: AcpTransientTransportErrorKind;
  summary: string;
  retryable: true;
};

type TransportPattern = {
  kind: AcpTransientTransportErrorKind;
  summary: string;
  patterns: RegExp[];
};

const ANSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/gu;

const TRANSPORT_PATTERNS: TransportPattern[] = [
  {
    kind: "provider_stream_disconnected",
    summary: "provider response stream disconnected before completion",
    patterns: [
      /ResponseStreamDisconnected/u,
      /stream disconnected before completion/iu,
      /error sending request for url/iu,
      /backend-api\/codex\/responses/u,
    ],
  },
  {
    kind: "acp_session_stream_closed",
    summary: "ACP session stream closed before completion",
    patterns: [/\bWritableIterable is closed\b/iu],
  },
  {
    kind: "socket_reset",
    summary: "network socket was reset or closed during the request",
    patterns: [
      /Connection reset by peer/iu,
      /\bECONNRESET\b/u,
      /\bUND_ERR_SOCKET\b/u,
      /socket hang up/iu,
    ],
  },
  {
    kind: "provider_fetch_failed",
    summary: "provider fetch failed before a response completed",
    patterns: [/\bfetch failed\b/iu, /network connection error/iu],
  },
  {
    kind: "telegram_transport_socket",
    summary: "Telegram delivery transport had a temporary socket failure",
    patterns: [/telegram transport.*temporarily unhealthy/iu, /telegram.*UND_ERR_SOCKET/iu],
  },
];

function normalizeTransportText(text: string): string {
  return text.replace(ANSI_PATTERN, " ").replace(/\s+/gu, " ").trim();
}

export function classifyAcpTransientTransportErrorText(
  text: string,
): AcpTransientTransportError | null {
  const normalized = normalizeTransportText(text);
  if (!normalized) {
    return null;
  }
  const match = TRANSPORT_PATTERNS.find((entry) =>
    entry.patterns.some((pattern) => pattern.test(normalized)),
  );
  return match ? { kind: match.kind, summary: match.summary, retryable: true } : null;
}

export function isAcpTransientTransportErrorText(text: string): boolean {
  return classifyAcpTransientTransportErrorText(text) !== null;
}
