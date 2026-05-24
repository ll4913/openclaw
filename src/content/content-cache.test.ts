import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readContentCache, writeContentCache } from "./content-cache.js";

let tmpDir = "";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-content-cache-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("content cache", () => {
  it("writes JSON and Markdown artifacts and reads within TTL", async () => {
    const artifact = await writeContentCache({
      key: "x-status-1",
      json: { ok: true },
      markdown: "# hi",
      cacheDir: tmpDir,
    });
    expect(await fs.readFile(artifact.markdownPath, "utf8")).toBe("# hi\n");
    const cached = await readContentCache({ key: "x-status-1", cacheDir: tmpDir, ttlMs: 60_000 });
    expect(cached.hit).toBe(true);
    if (cached.hit) {
      expect(cached.artifact.jsonPath).toBe(path.join(tmpDir, "x-status-1.json"));
      expect(cached.artifact.markdown).toBe("# hi\n");
    }
  });

  it("honors refresh bypass and TTL expiry", async () => {
    await writeContentCache({
      key: "x-status-2",
      json: { ok: true },
      markdown: "body",
      cacheDir: tmpDir,
    });
    expect(
      (await readContentCache({ key: "x-status-2", cacheDir: tmpDir, refresh: true })).hit,
    ).toBe(false);
    expect((await readContentCache({ key: "x-status-2", cacheDir: tmpDir, ttlMs: -1 })).hit).toBe(
      false,
    );
  });
});
