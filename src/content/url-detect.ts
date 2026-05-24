const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com"]);

export type XUrlKind = "status" | "article";

export type DetectedXUrl = {
  originalUrl: string;
  canonicalUrl: string;
  host: "x.com";
  id: string;
  kind: XUrlKind;
  cacheKey: string;
};

function trimTrailingUrlPunctuation(value: string): string {
  return value.replace(/[),.;!?]+$/g, "");
}

export function canonicalizeXUrl(rawUrl: string): DetectedXUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(trimTrailingUrlPunctuation(rawUrl));
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (!X_HOSTS.has(host)) {
    return null;
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  let id: string | undefined;
  let kind: XUrlKind | undefined;
  if (parts.length >= 3 && parts[1] === "status" && /^\d+$/.test(parts[2] ?? "")) {
    id = parts[2];
    kind = "status";
  } else if (
    parts.length >= 3 &&
    parts[0] === "i" &&
    parts[1] === "article" &&
    /^\d+$/.test(parts[2] ?? "")
  ) {
    id = parts[2];
    kind = "article";
  }
  if (!id || !kind) {
    return null;
  }

  const canonicalUrl =
    kind === "article" ? `https://x.com/i/article/${id}` : `https://x.com/${parts[0]}/status/${id}`;
  return {
    originalUrl: rawUrl,
    canonicalUrl,
    host: "x.com",
    id,
    kind,
    cacheKey: `x-status-${id}`,
  };
}

const URL_RE = /https?:\/\/(?:x\.com|twitter\.com|mobile\.twitter\.com)\/[^\s<>()]+/gi;

export function detectXUrls(text: string): DetectedXUrl[] {
  const seen = new Set<string>();
  const urls: DetectedXUrl[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const detected = canonicalizeXUrl(match[0]);
    if (!detected || seen.has(detected.cacheKey)) {
      continue;
    }
    seen.add(detected.cacheKey);
    urls.push(detected);
  }
  return urls;
}
