import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  claimTelegramSpooledUpdate,
  deleteTelegramSpooledUpdate,
  failTelegramSpooledUpdateClaim,
  isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess,
  listTelegramSpooledUpdateClaims,
  listTelegramSpooledUpdates,
  recoverStaleTelegramSpooledUpdateClaims,
  releaseTelegramSpooledUpdateClaim,
  summarizeTelegramIngressSpool,
  TELEGRAM_SPOOLED_UPDATE_PROCESSING_STALE_MS,
  writeTelegramSpooledUpdate,
} from "./telegram-ingress-spool.js";

async function withTempSpool<T>(fn: (spoolDir: string) => Promise<T>): Promise<T> {
  const spoolDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
  try {
    return await fn(spoolDir);
  } finally {
    await fs.rm(spoolDir, { recursive: true, force: true });
  }
}

describe("Telegram ingress spool", () => {
  it("persists updates durably in update_id order and deletes handled entries", async () => {
    await withTempSpool(async (spoolDir) => {
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 11, message: { text: "second" } },
        now: 2,
      });
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 10, message: { text: "first" } },
        now: 1,
      });

      const updates = await listTelegramSpooledUpdates({ spoolDir });

      expect(updates.map((update) => update.updateId)).toEqual([10, 11]);
      expect(updates.map((update) => update.receivedAt)).toEqual([1, 2]);
      expect(updates[0]?.update).toEqual({ update_id: 10, message: { text: "first" } });

      if (!updates[0]) {
        throw new Error("Expected a spooled update");
      }
      await deleteTelegramSpooledUpdate(updates[0]);

      expect(
        (await listTelegramSpooledUpdates({ spoolDir })).map((update) => update.updateId),
      ).toEqual([11]);
    });
  });

  it("claims active updates so they are hidden from pending drain lists", async () => {
    await withTempSpool(async (spoolDir) => {
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 20, message: { text: "active" } },
      });
      const update = (await listTelegramSpooledUpdates({ spoolDir }))[0];
      if (!update) {
        throw new Error("Expected a spooled update");
      }

      const claimed = await claimTelegramSpooledUpdate(update);

      expect(claimed?.updateId).toBe(20);
      expect(claimed?.path.endsWith(".json.processing")).toBe(true);
      expect(await listTelegramSpooledUpdates({ spoolDir })).toEqual([]);
      expect(
        (await listTelegramSpooledUpdateClaims({ spoolDir })).map((claim) => claim.updateId),
      ).toEqual([20]);

      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 20, message: { text: "duplicate" } },
      });
      expect(await listTelegramSpooledUpdates({ spoolDir })).toEqual([]);

      if (!claimed) {
        throw new Error("Expected a claimed update");
      }
      await fs.writeFile(claimed.pendingPath, "duplicate pending race", { mode: 0o600 });
      await deleteTelegramSpooledUpdate(claimed);
      expect(await fs.readdir(spoolDir)).toEqual([]);
    });
  });

  it("releases failed claims back to the pending spool", async () => {
    await withTempSpool(async (spoolDir) => {
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 30, message: { text: "retry me" } },
      });
      const update = (await listTelegramSpooledUpdates({ spoolDir }))[0];
      if (!update) {
        throw new Error("Expected a spooled update");
      }
      const claimed = await claimTelegramSpooledUpdate(update);
      if (!claimed) {
        throw new Error("Expected a claimed update");
      }

      await releaseTelegramSpooledUpdateClaim(claimed);

      const updates = await listTelegramSpooledUpdates({ spoolDir });
      expect(updates.map((entry) => entry.updateId)).toEqual([30]);
      expect(updates[0]?.path.endsWith(".json")).toBe(true);
    });
  });

  it("marks timed out claims failed without requeueing them", async () => {
    await withTempSpool(async (spoolDir) => {
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 32, message: { text: "poison" } },
      });
      const update = (await listTelegramSpooledUpdates({ spoolDir }))[0];
      if (!update) {
        throw new Error("Expected a spooled update");
      }
      const claimed = await claimTelegramSpooledUpdate(update);
      if (!claimed) {
        throw new Error("Expected a claimed update");
      }

      await expect(
        failTelegramSpooledUpdateClaim({
          update: claimed,
          reason: "handler-timeout",
          message: "timed out",
          now: 123,
        }),
      ).resolves.toBe(true);

      expect(await listTelegramSpooledUpdates({ spoolDir })).toEqual([]);
      expect(await listTelegramSpooledUpdateClaims({ spoolDir })).toEqual([]);
      const entries = await fs.readdir(spoolDir);
      expect(entries).toEqual(["0000000000000032.json.failed"]);
      const failed = JSON.parse(
        await fs.readFile(path.join(spoolDir, "0000000000000032.json.failed"), "utf8"),
      ) as {
        update?: unknown;
        claim?: unknown;
        failure?: { reason?: string; message?: string; failedAt?: number };
      };
      expect(failed.update).toBeUndefined();
      expect(failed.claim).toBeUndefined();
      expect(failed.failure).toEqual({
        reason: "handler-timeout",
        message: "timed out",
        failedAt: 123,
      });

      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 32, message: { text: "redelivered poison" } },
      });
      expect(await listTelegramSpooledUpdates({ spoolDir })).toEqual([]);
      expect(await fs.readdir(spoolDir)).toEqual(["0000000000000032.json.failed"]);

      const leakedProcessingPath = path.join(spoolDir, "0000000000000032.json.processing");
      await fs.writeFile(
        leakedProcessingPath,
        `${JSON.stringify({
          version: 1,
          updateId: 32,
          receivedAt: 100,
          update: { update_id: 32, message: { text: "crashed poison claim" } },
        })}\n`,
        { mode: 0o600 },
      );
      const staleTime = new Date(Date.now() - TELEGRAM_SPOOLED_UPDATE_PROCESSING_STALE_MS - 1);
      await fs.utimes(leakedProcessingPath, staleTime, staleTime);

      await expect(recoverStaleTelegramSpooledUpdateClaims({ spoolDir })).resolves.toBe(0);
      expect(await listTelegramSpooledUpdates({ spoolDir })).toEqual([]);
      expect(await listTelegramSpooledUpdateClaims({ spoolDir })).toEqual([]);
      expect(await fs.readdir(spoolDir)).toEqual(["0000000000000032.json.failed"]);
    });
  });

  it("does not claim an update after the pending file is gone", async () => {
    await withTempSpool(async (spoolDir) => {
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 35, message: { text: "already handled" } },
      });
      const update = (await listTelegramSpooledUpdates({ spoolDir }))[0];
      if (!update) {
        throw new Error("Expected a spooled update");
      }
      await deleteTelegramSpooledUpdate(update);

      await expect(claimTelegramSpooledUpdate(update)).resolves.toBeNull();
      expect(await fs.readdir(spoolDir)).toEqual([]);
    });
  });

  it("treats missing processing markers as an already-cleaned completion race", async () => {
    await withTempSpool(async (spoolDir) => {
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 36, message: { text: "cleanup race" } },
      });
      const update = (await listTelegramSpooledUpdates({ spoolDir }))[0];
      if (!update) {
        throw new Error("Expected a spooled update");
      }
      const claimed = await claimTelegramSpooledUpdate(update);
      if (!claimed) {
        throw new Error("Expected a claimed update");
      }
      await fs.unlink(claimed.path);

      await expect(deleteTelegramSpooledUpdate(claimed)).resolves.toBeUndefined();
      expect(await fs.readdir(spoolDir)).toEqual([]);
    });
  });

  it("recovers stale processing claims without replaying fresh claims", async () => {
    await withTempSpool(async (spoolDir) => {
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 40, message: { text: "fresh" } },
      });
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 41, message: { text: "stale" } },
      });
      const updates = await listTelegramSpooledUpdates({ spoolDir });
      const fresh = updates.find((update) => update.updateId === 40);
      const stale = updates.find((update) => update.updateId === 41);
      if (!fresh || !stale) {
        throw new Error("Expected spooled updates");
      }
      const claimedFresh = await claimTelegramSpooledUpdate(fresh);
      const claimedStale = await claimTelegramSpooledUpdate(stale);
      if (!claimedFresh || !claimedStale) {
        throw new Error("Expected claimed updates");
      }
      const now = Date.now();
      const oldClaimTime = new Date(now - TELEGRAM_SPOOLED_UPDATE_PROCESSING_STALE_MS - 1);
      await fs.utimes(claimedStale.path, oldClaimTime, oldClaimTime);

      const recovered = await recoverStaleTelegramSpooledUpdateClaims({
        spoolDir,
        now,
      });

      expect(recovered).toBe(1);
      expect(
        (await listTelegramSpooledUpdates({ spoolDir })).map((update) => update.updateId),
      ).toEqual([41]);
      expect((await fs.readdir(spoolDir)).toSorted()).toEqual([
        "0000000000000040.json.processing",
        "0000000000000041.json",
      ]);
    });
  });

  it("recovers fresh processing claims when the claiming pid is gone", async () => {
    await withTempSpool(async (spoolDir) => {
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 45, message: { text: "dead owner" } },
      });
      const update = (await listTelegramSpooledUpdates({ spoolDir }))[0];
      if (!update) {
        throw new Error("Expected a spooled update");
      }
      const claimed = await claimTelegramSpooledUpdate(update);
      if (!claimed) {
        throw new Error("Expected a claimed update");
      }
      const now = Date.now();
      await fs.writeFile(
        claimed.path,
        `${JSON.stringify({
          version: 1,
          updateId: 45,
          receivedAt: update.receivedAt,
          update: update.update,
          claim: {
            processId: "dead-process",
            processPid: 999_999_999,
            claimedAt: now,
          },
        })}\n`,
        { mode: 0o600 },
      );

      const recovered = await recoverStaleTelegramSpooledUpdateClaims({
        spoolDir,
        now,
      });

      expect(recovered).toBe(1);
      expect(
        (await listTelegramSpooledUpdates({ spoolDir })).map((entry) => entry.updateId),
      ).toEqual([45]);
      expect(await listTelegramSpooledUpdateClaims({ spoolDir })).toEqual([]);
    });
  });

  it("summarizes pending, processing, and failed spool age for health surfaces", async () => {
    await withTempSpool(async (spoolDir) => {
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 46, message: { text: "pending" } },
        now: 1_000,
      });
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 47, message: { text: "processing" } },
        now: 2_000,
      });
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 48, message: { text: "failed" } },
        now: 3_000,
      });
      const processingUpdate = (await listTelegramSpooledUpdates({ spoolDir })).find(
        (update) => update.updateId === 47,
      );
      const failedUpdate = (await listTelegramSpooledUpdates({ spoolDir })).find(
        (update) => update.updateId === 48,
      );
      if (!processingUpdate || !failedUpdate) {
        throw new Error("Expected spooled updates");
      }
      const processingClaim = await claimTelegramSpooledUpdate(processingUpdate);
      const failedClaim = await claimTelegramSpooledUpdate(failedUpdate);
      if (!processingClaim || !failedClaim) {
        throw new Error("Expected claimed updates");
      }
      await failTelegramSpooledUpdateClaim({
        update: failedClaim,
        reason: "test",
        message: "failed",
        now: 4_000,
      });

      const summary = await summarizeTelegramIngressSpool({
        spoolDir,
        now: Date.now() + 1_000,
      });

      expect(summary.pending).toBe(1);
      expect(summary.processing).toBe(1);
      expect(summary.failed).toBe(1);
      expect(summary.oldestPendingAgeMs).toBeGreaterThan(0);
      expect(summary.oldestProcessingAgeMs).toBeGreaterThanOrEqual(0);
    });
  });

  it("skips spool entries that disappear while summarizing health surfaces", async () => {
    await withTempSpool(async (spoolDir) => {
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 49, message: { text: "pending race" } },
        now: 1_000,
      });
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: { update_id: 50, message: { text: "processing race" } },
        now: 2_000,
      });
      const processingUpdate = (await listTelegramSpooledUpdates({ spoolDir })).find(
        (update) => update.updateId === 50,
      );
      if (!processingUpdate) {
        throw new Error("Expected a processing update");
      }
      const processingClaim = await claimTelegramSpooledUpdate(processingUpdate);
      if (!processingClaim) {
        throw new Error("Expected a processing claim");
      }
      const pendingPath = path.join(spoolDir, "0000000000000049.json");
      const racedPaths = new Set([pendingPath, processingClaim.path]);
      const originalStat = fs.stat.bind(fs) as typeof fs.stat;
      const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
        const [target] = args;
        if (racedPaths.has(String(target))) {
          racedPaths.delete(String(target));
          await fs.unlink(String(target)).catch((err: { code?: string }) => {
            if (err.code !== "ENOENT") {
              throw err;
            }
          });
          const gone = new Error("spooled update moved during summary") as NodeJS.ErrnoException;
          gone.code = "ENOENT";
          throw gone;
        }
        return originalStat(...args);
      });
      try {
        const summary = await summarizeTelegramIngressSpool({
          spoolDir,
          now: Date.now() + 1_000,
        });

        expect(summary.pending).toBe(0);
        expect(summary.processing).toBe(0);
        expect(summary.failed).toBe(0);
        expect(summary.oldestPendingAgeMs).toBeNull();
        expect(summary.oldestProcessingAgeMs).toBeNull();
      } finally {
        statSpy.mockRestore();
      }
    });
  });

  it("does not treat stale claims with reused pids as live-owned", () => {
    const now = Date.now();
    expect(
      isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess({
        updateId: 50,
        path: path.join(os.tmpdir(), "50.json.processing"),
        pendingPath: path.join(os.tmpdir(), "50.json"),
        update: { update_id: 50 },
        receivedAt: now,
        claim: {
          processId: "other-process",
          processPid: process.pid,
          claimedAt: now - TELEGRAM_SPOOLED_UPDATE_PROCESSING_STALE_MS - 1,
        },
      }),
    ).toBe(false);
  });
});
