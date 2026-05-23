const LOCALHOST_REFERENCE_PATTERNS = [
  /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(?::\d+)?[^\s`<>)，。]*/iu,
  /\blocalhost:\d+\b/iu,
] as const;

const LOCALHOST_NOTE =
  "⚠️ Local verification only: localhost links work only on the agent host. Share a screenshot or deploy/preview URL for user acceptance.";

const CREDENTIALS_NOTE =
  "⚠️ Credentials redacted: use the configured private session or secret store; do not post passwords in chat.";

function includesAnyPattern(input: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(input));
}

function appendNotice(input: string, notice: string): string {
  if (input.includes(notice)) {
    return input;
  }
  const separator = input.trimEnd().length > 0 ? "\n\n" : "";
  return `${input.trimEnd()}${separator}${notice}`;
}

function redactCredentialText(input: string): { text: string; redacted: boolean } {
  let redacted = false;
  const replace = (value: string) => {
    if (value === input) {
      return value;
    }
    redacted = true;
    return value;
  };

  let text = input.replace(
    /((?:用户名|账号|username|user)\s*`?)[^`\s，,。]+(`?\s*[，,]\s*(?:密码|口令|password|passcode)\s*`?)[^`\s，,。]+(`?)/giu,
    (_match, userPrefix: string, passwordPrefix: string, suffix: string) =>
      `${userPrefix}[redacted]${passwordPrefix}[redacted]${suffix}`,
  );
  text = replace(text);

  const beforePasswordRedaction = text;
  text = text.replace(
    /((?:密码|口令|password|passcode)\s*[:：=]\s*`?)[^`\s，,。]+(`?)/giu,
    (_match, prefix: string, suffix: string) => `${prefix}[redacted]${suffix}`,
  );
  if (text !== beforePasswordRedaction) {
    redacted = true;
  }

  return { text, redacted };
}

export function sanitizeAcpVisibleLocalDeliveryText(input: string): string {
  const credentialResult = redactCredentialText(input);
  let text = credentialResult.text;
  if (includesAnyPattern(text, LOCALHOST_REFERENCE_PATTERNS)) {
    text = appendNotice(text, LOCALHOST_NOTE);
  }
  if (credentialResult.redacted) {
    text = appendNotice(text, CREDENTIALS_NOTE);
  }
  return text;
}
