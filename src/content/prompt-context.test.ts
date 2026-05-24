import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeContentCache } from "./content-cache.js";
import { appendXPromptContext } from "./prompt-context.js";

let tmpDir = "";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-x-context-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("X prompt context", () => {
  it("injects cached X content as untrusted block", async () => {
    await writeContentCache({
      key: "x-status-123",
      json: { ok: true },
      markdown: "# Cached\nbody",
      cacheDir: tmpDir,
    });
    const prompt = await appendXPromptContext("summarize https://x.com/u/status/123?s=1", {
      cacheDir: tmpDir,
      logger: () => undefined,
    });
    expect(prompt).toContain("<untrusted_x_content");
    expect(prompt).toContain("Markdown artifact:");
    expect(prompt).toContain("# Cached");
    expect(prompt).toContain("summarize https://x.com/u/status/123?s=1");
  });

  it("leaves non-X prompts unchanged", async () => {
    await expect(
      appendXPromptContext("hello https://example.com", { cacheDir: tmpDir }),
    ).resolves.toBe("hello https://example.com");
  });

  it("returns structured degraded block on extractor failure", async () => {
    const prompt = await appendXPromptContext("read https://x.com/u/status/555", {
      cacheDir: tmpDir,
      logger: () => undefined,
      extractor: {
        extract: async () => {
          throw new Error("boom");
        },
      } as never,
    });
    expect(prompt).toContain("<untrusted_x_content");
    expect(prompt).toContain("Extraction status: failed");
    expect(prompt).toContain("boom");
  });
});
