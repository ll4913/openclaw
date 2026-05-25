import { describe, expect, it } from "vitest";
import { projectSafeChannelAccountSnapshotFields } from "./account-snapshot-fields.js";

describe("projectSafeChannelAccountSnapshotFields", () => {
  it("omits webhook and public-key style fields from generic snapshots", () => {
    const snapshot = projectSafeChannelAccountSnapshotFields({
      name: "Primary",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
      signingSecretSource: "config", // pragma: allowlist secret
      signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
      webhookUrl: "https://example.com/webhook",
      webhookPath: "/webhook",
      audienceType: "project-number",
      audience: "1234567890",
      publicKey: "pk_live_123",
    });

    expect(snapshot).toEqual({
      name: "Primary",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
      signingSecretSource: "config", // pragma: allowlist secret
      signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
    });
  });

  it("strips embedded credentials from baseUrl fields", () => {
    const snapshot = projectSafeChannelAccountSnapshotFields({
      baseUrl: "https://bob:secret@chat.example.test",
    });

    expect(snapshot).toEqual({
      baseUrl: "https://chat.example.test/",
    });
  });

  it("preserves non-secret transport liveness timestamps", () => {
    const snapshot = projectSafeChannelAccountSnapshotFields({
      connected: true,
      lastConnectedAt: 123,
      lastInboundAt: 123,
      lastOutboundAt: 234,
      lastMessageAt: null,
      lastEventAt: 345,
      lastTransportActivityAt: 456,
      channelAccessToken: "line-token",
      channelSecret: "line-secret", // pragma: allowlist secret
      probe: { ok: true, token: "probe-secret" },
    });

    expect(snapshot).toEqual({
      connected: true,
      lastConnectedAt: 123,
      lastInboundAt: 123,
      lastOutboundAt: 234,
      lastMessageAt: null,
      lastEventAt: 345,
      lastTransportActivityAt: 456,
    });
  });

  it("preserves non-secret spool diagnostics", () => {
    const snapshot = projectSafeChannelAccountSnapshotFields({
      spool: {
        pending: 2,
        processing: 1,
        failed: 3,
        oldestPendingAgeMs: 4,
        oldestProcessingAgeMs: 5,
        activeHandlers: 1,
        oldestActiveHandlerAgeMs: 6,
        ignored: "drop-me",
      },
    });

    expect(snapshot).toEqual({
      spool: {
        pending: 2,
        processing: 1,
        failed: 3,
        oldestPendingAgeMs: 4,
        oldestProcessingAgeMs: 5,
        activeHandlers: 1,
        oldestActiveHandlerAgeMs: 6,
      },
    });
  });
});
