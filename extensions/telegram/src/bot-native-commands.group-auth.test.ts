import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ChannelGroupPolicy } from "openclaw/plugin-sdk/config-contracts";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  createNativeCommandsHarness,
  createTelegramGroupCommandContext,
  findNotAuthorizedCalls,
  getNativeCommandDispatchMock,
} from "./bot-native-commands.test-helpers.js";

describe("native command auth in groups", () => {
  function setup(params: {
    cfg?: OpenClawConfig;
    telegramCfg?: TelegramAccountConfig;
    allowFrom?: string[];
    groupAllowFrom?: string[];
    storeAllowFrom?: string[];
    useAccessGroups?: boolean;
    groupConfig?: Record<string, unknown>;
    resolveGroupPolicy?: () => ChannelGroupPolicy;
    accountId?: string;
  }) {
    return createNativeCommandsHarness({
      cfg: params.cfg ?? ({} as OpenClawConfig),
      telegramCfg: params.telegramCfg ?? ({} as TelegramAccountConfig),
      allowFrom: params.allowFrom ?? [],
      groupAllowFrom: params.groupAllowFrom ?? [],
      storeAllowFrom: params.storeAllowFrom,
      useAccessGroups: params.useAccessGroups ?? false,
      resolveGroupPolicy:
        params.resolveGroupPolicy ??
        (() =>
          ({
            allowlistEnabled: false,
            allowed: true,
          }) as ChannelGroupPolicy),
      groupConfig: params.groupConfig,
      accountId: params.accountId,
    });
  }

  it("authorizes native commands in groups when sender is in groupAllowFrom", async () => {
    const { handlers, sendMessage } = setup({
      groupAllowFrom: ["12345"],
      useAccessGroups: true,
      // no allowFrom — sender is NOT in DM allowlist
    });

    const ctx = createTelegramGroupCommandContext();

    await handlers.status?.(ctx);

    const notAuthCalls = findNotAuthorizedCalls(sendMessage);
    expect(notAuthCalls).toHaveLength(0);
  });

  it("does not authorize group native commands from the DM allowlist store", async () => {
    const { handlers, sendMessage } = setup({
      storeAllowFrom: ["12345"],
      useAccessGroups: true,
    });

    const ctx = createTelegramGroupCommandContext();

    await handlers.status?.(ctx);

    const notAuthCalls = findNotAuthorizedCalls(sendMessage);
    expect(notAuthCalls.length).toBeGreaterThan(0);
  });

  it("authorizes native commands in groups from commands.allowFrom.telegram", async () => {
    const { handlers, sendMessage } = setup({
      cfg: {
        commands: {
          allowFrom: {
            telegram: ["12345"],
          },
        },
      } as OpenClawConfig,
      allowFrom: ["99999"],
      groupAllowFrom: ["99999"],
      useAccessGroups: true,
    });

    const ctx = createTelegramGroupCommandContext();

    await handlers.status?.(ctx);

    const notAuthCalls = findNotAuthorizedCalls(sendMessage);
    expect(notAuthCalls).toHaveLength(0);
  });

  it("uses commands.allowFrom.telegram as the sole auth source when configured", async () => {
    const { handlers, sendMessage } = setup({
      cfg: {
        commands: {
          allowFrom: {
            telegram: ["99999"],
          },
        },
      } as OpenClawConfig,
      groupAllowFrom: ["12345"],
      useAccessGroups: true,
    });

    const ctx = createTelegramGroupCommandContext();

    await handlers.status?.(ctx);

    expect(sendMessage).toHaveBeenCalledWith(
      -100999,
      "You are not authorized to use this command.",
      { message_thread_id: 42 },
    );
  });

  it("keeps groupPolicy disabled enforced when commands.allowFrom is configured", async () => {
    const { handlers, sendMessage } = setup({
      cfg: {
        channels: {
          telegram: {
            groupPolicy: "disabled",
          },
        },
        commands: {
          allowFrom: {
            telegram: ["12345"],
          },
        },
      } as OpenClawConfig,
      useAccessGroups: true,
      resolveGroupPolicy: () =>
        ({
          allowlistEnabled: false,
          allowed: false,
        }) as ChannelGroupPolicy,
    });

    const ctx = createTelegramGroupCommandContext();

    await handlers.status?.(ctx);

    expect(sendMessage).toHaveBeenCalledWith(-100999, "Telegram group commands are disabled.", {
      message_thread_id: 42,
    });
  });

  it("keeps group chat allowlists enforced when commands.allowFrom is configured", async () => {
    const { handlers, sendMessage } = setup({
      cfg: {
        commands: {
          allowFrom: {
            telegram: ["12345"],
          },
        },
      } as OpenClawConfig,
      useAccessGroups: true,
      resolveGroupPolicy: () =>
        ({
          allowlistEnabled: true,
          allowed: false,
        }) as ChannelGroupPolicy,
    });

    const ctx = createTelegramGroupCommandContext();

    await handlers.status?.(ctx);

    expect(sendMessage).toHaveBeenCalledWith(-100999, "This group is not allowed.", {
      message_thread_id: 42,
    });
  });

  it("rejects native commands in groups when sender is in neither allowlist", async () => {
    const { handlers, sendMessage } = setup({
      allowFrom: ["99999"],
      groupAllowFrom: ["99999"],
      useAccessGroups: true,
    });

    const ctx = createTelegramGroupCommandContext({
      username: "intruder",
    });

    await handlers.status?.(ctx);

    const notAuthCalls = findNotAuthorizedCalls(sendMessage);
    expect(notAuthCalls.length).toBeGreaterThan(0);
  });

  it("replies in the originating forum topic when auth is rejected", async () => {
    const { handlers, sendMessage } = setup({
      allowFrom: ["99999"],
      groupAllowFrom: ["99999"],
      useAccessGroups: true,
    });

    const ctx = createTelegramGroupCommandContext({
      username: "intruder",
    });

    await handlers.status?.(ctx);

    expect(sendMessage).toHaveBeenCalledWith(
      -100999,
      "You are not authorized to use this command.",
      { message_thread_id: 42 },
    );
  });

  it("ignores untargeted group /acp native commands", async () => {
    const dispatchReply = getNativeCommandDispatchMock();
    dispatchReply.mockClear();
    const { handlers, sendMessage } = setup({
      accountId: "mc-bot",
      groupAllowFrom: ["12345"],
      useAccessGroups: true,
    });

    const ctx = createTelegramGroupCommandContext({
      text: "/acp spawn codex --bind here",
      botUsername: "mc_bot",
    });

    await handlers.acp?.(ctx);

    expect(dispatchReply).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("handles group /acp native commands targeted at this bot", async () => {
    const dispatchReply = getNativeCommandDispatchMock();
    dispatchReply.mockClear();
    const { handlers } = setup({
      accountId: "mc-bot",
      groupAllowFrom: ["12345"],
      useAccessGroups: true,
    });

    const ctx = createTelegramGroupCommandContext({
      text: "/acp@mc_bot spawn codex --bind here",
      botUsername: "mc_bot",
    });

    await handlers.acp?.(ctx);

    expect(dispatchReply).toHaveBeenCalledTimes(1);
  });

  it("ignores group /acp native commands targeted at another bot", async () => {
    const dispatchReply = getNativeCommandDispatchMock();
    dispatchReply.mockClear();
    const { handlers, sendMessage } = setup({
      accountId: "mc-bot",
      groupAllowFrom: ["12345"],
      useAccessGroups: true,
    });

    const ctx = createTelegramGroupCommandContext({
      text: "/acp@engineer_bot spawn codex --bind here",
      botUsername: "mc_bot",
    });

    await handlers.acp?.(ctx);

    expect(dispatchReply).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
