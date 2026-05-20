import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeTelegramCommandName } from "./command-config.js";

export function resolveTelegramSlashCommandTargetUsername(params: {
  text: string | undefined;
  commandName: string;
}): string | null | undefined {
  const text = params.text?.trimStart() ?? "";
  if (!text) {
    return undefined;
  }
  const match = /^\/([A-Za-z0-9_-]+)(?:@([A-Za-z0-9_]+))?(?=\s|$)/.exec(text);
  if (!match) {
    return undefined;
  }
  const normalizedActual = normalizeTelegramCommandName(match[1] ?? "");
  const normalizedExpected = normalizeTelegramCommandName(params.commandName);
  if (normalizedActual !== normalizedExpected) {
    return undefined;
  }
  return normalizeOptionalLowercaseString(match[2]) ?? null;
}

export function normalizeTelegramMentionPrefixedCommandBody(
  text: string,
  botUsername: string | null | undefined,
): string {
  const normalizedBotUsername = normalizeOptionalLowercaseString(botUsername);
  if (!normalizedBotUsername) {
    return text;
  }
  const match = /^\s*@([A-Za-z0-9_]+)\b\s+([\s\S]*)$/.exec(text);
  if (!match) {
    return text;
  }
  const targetUsername = normalizeOptionalLowercaseString(match[1]);
  const commandBody = match[2]?.trimStart() ?? "";
  if (targetUsername !== normalizedBotUsername || !commandBody.startsWith("/")) {
    return text;
  }
  return commandBody;
}
