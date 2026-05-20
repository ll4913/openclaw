import { describe, expect, it } from "vitest";
import {
  normalizeTelegramMentionPrefixedCommandBody,
  resolveTelegramSlashCommandTargetUsername,
} from "./command-targeting.js";

describe("Telegram command targeting", () => {
  it("normalizes mention-prefixed commands for the addressed bot", () => {
    expect(normalizeTelegramMentionPrefixedCommandBody("@mc_bot /acp status", "MC_Bot")).toBe(
      "/acp status",
    );
  });

  it("leaves mention-prefixed commands for other bots unchanged", () => {
    expect(normalizeTelegramMentionPrefixedCommandBody("@engineer_bot /acp status", "mc_bot")).toBe(
      "@engineer_bot /acp status",
    );
  });

  it("ignores leading mentions that are not commands", () => {
    expect(normalizeTelegramMentionPrefixedCommandBody("@mc_bot please check this", "mc_bot")).toBe(
      "@mc_bot please check this",
    );
  });

  it("resolves targeted slash commands distinctly from bare commands", () => {
    expect(
      resolveTelegramSlashCommandTargetUsername({
        text: "/acp@mc_bot spawn codex",
        commandName: "acp",
      }),
    ).toBe("mc_bot");
    expect(
      resolveTelegramSlashCommandTargetUsername({
        text: "/acp spawn codex",
        commandName: "acp",
      }),
    ).toBeNull();
  });
});
