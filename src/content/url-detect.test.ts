import { describe, expect, it } from "vitest";
import { canonicalizeXUrl, detectXUrls } from "./url-detect.js";

describe("X URL detection", () => {
  it("canonicalizes status URLs and strips tracking", () => {
    const url = canonicalizeXUrl(
      "https://twitter.com/llin/status/2055341758523883631?s=52&t=secret",
    );
    expect(url).toMatchObject({
      canonicalUrl: "https://x.com/llin/status/2055341758523883631",
      id: "2055341758523883631",
      kind: "status",
      cacheKey: "x-status-2055341758523883631",
    });
  });

  it("canonicalizes mobile twitter and x article URLs to stable cache keys", () => {
    expect(canonicalizeXUrl("https://mobile.twitter.com/user/status/1234567890")?.cacheKey).toBe(
      "x-status-1234567890",
    );
    expect(canonicalizeXUrl("https://x.com/i/article/1234567890?s=1")?.cacheKey).toBe(
      "x-status-1234567890",
    );
  });

  it("detects unique X URLs in text", () => {
    const urls = detectXUrls(
      "read https://x.com/a/status/1?s=1 and https://twitter.com/a/status/1?t=2 plus https://x.com/i/article/2.",
    );
    expect(urls.map((url) => url.cacheKey)).toEqual(["x-status-1", "x-status-2"]);
  });
});
