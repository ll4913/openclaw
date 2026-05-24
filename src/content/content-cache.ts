import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_CONTENT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type ContentCacheArtifact = {
  key: string;
  jsonPath: string;
  markdownPath: string;
  json: unknown;
  markdown: string;
  createdAt: string;
};

export type ContentCacheReadResult =
  | { hit: true; artifact: ContentCacheArtifact }
  | { hit: false; reason: "missing" | "expired" | "invalid" };

export function resolveXContentCacheDir(
  baseDir = path.join(os.homedir(), ".openclaw", "content-cache", "x"),
): string {
  return baseDir;
}

function artifactPaths(key: string, cacheDir: string): { jsonPath: string; markdownPath: string } {
  const safeKey = key.replace(/[^a-zA-Z0-9._-]/g, "-");
  return {
    jsonPath: path.join(cacheDir, `${safeKey}.json`),
    markdownPath: path.join(cacheDir, `${safeKey}.md`),
  };
}

export async function readContentCache(params: {
  key: string;
  cacheDir?: string;
  ttlMs?: number;
  refresh?: boolean;
  now?: number;
}): Promise<ContentCacheReadResult> {
  if (params.refresh) {
    return { hit: false, reason: "expired" };
  }
  const cacheDir = resolveXContentCacheDir(params.cacheDir);
  const { jsonPath, markdownPath } = artifactPaths(params.key, cacheDir);
  try {
    const [jsonStat, jsonText, markdown] = await Promise.all([
      fs.stat(jsonPath),
      fs.readFile(jsonPath, "utf8"),
      fs.readFile(markdownPath, "utf8"),
    ]);
    const ttlMs = params.ttlMs ?? DEFAULT_CONTENT_CACHE_TTL_MS;
    if ((params.now ?? Date.now()) - jsonStat.mtimeMs > ttlMs) {
      return { hit: false, reason: "expired" };
    }
    const json = JSON.parse(jsonText) as Record<string, unknown>;
    return {
      hit: true,
      artifact: {
        key: params.key,
        jsonPath,
        markdownPath,
        json,
        markdown,
        createdAt:
          typeof json.created_at === "string"
            ? json.created_at
            : new Date(jsonStat.mtimeMs).toISOString(),
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { hit: false, reason: "missing" };
    }
    return { hit: false, reason: "invalid" };
  }
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, contents, "utf8");
  await fs.rename(tmpPath, filePath);
}

export async function writeContentCache(params: {
  key: string;
  json: unknown;
  markdown: string;
  cacheDir?: string;
}): Promise<ContentCacheArtifact> {
  const cacheDir = resolveXContentCacheDir(params.cacheDir);
  const { jsonPath, markdownPath } = artifactPaths(params.key, cacheDir);
  const createdAt = new Date().toISOString();
  const json =
    params.json && typeof params.json === "object" && !Array.isArray(params.json)
      ? { created_at: createdAt, ...params.json }
      : { created_at: createdAt, value: params.json };
  await atomicWrite(jsonPath, `${JSON.stringify(json, null, 2)}\n`);
  await atomicWrite(
    markdownPath,
    params.markdown.endsWith("\n") ? params.markdown : `${params.markdown}\n`,
  );
  return { key: params.key, jsonPath, markdownPath, json, markdown: params.markdown, createdAt };
}
