import { describe, expect, it } from "vitest";
import { formatAcpFinalReportText } from "./acp-final-report-format.js";

describe("formatAcpFinalReportText", () => {
  it("adds sparse Telegram-friendly icons to report headings", () => {
    const input = [
      "Result:",
      "Delivery candidate is ready.",
      "",
      "Changes:",
      "- Updated ACP final report formatting.",
      "",
      "Verification:",
      "- node scripts/run-vitest.mjs src/auto-reply/reply/acp-final-report-format.test.ts",
      "",
      "Notes:",
      "- No runtime config changed.",
      "",
      "Next:",
      "- Restart the gateway after review.",
    ].join("\n");

    expect(formatAcpFinalReportText(input)).toBe(
      [
        "✅ 结果",
        "Delivery candidate is ready.",
        "",
        "🔧 改动",
        "- Updated ACP final report formatting.",
        "",
        "🧪 验证",
        "- node scripts/run-vitest.mjs src/auto-reply/reply/acp-final-report-format.test.ts",
        "",
        "⚠️ 注意",
        "- No runtime config changed.",
        "",
        "➡️ 下一步",
        "- Restart the gateway after review.",
      ].join("\n"),
    );
  });

  it("recognizes Chinese report headings", () => {
    const input = [
      "改动：",
      "- 精简最终回复结构。",
      "验证：",
      "- 测试通过。",
      "下一步：",
      "- 观察下一次 ACP 回复。",
    ].join("\n");

    expect(formatAcpFinalReportText(input)).toBe(
      [
        "🔧 改动",
        "- 精简最终回复结构。",
        "",
        "🧪 验证",
        "- 测试通过。",
        "",
        "➡️ 下一步",
        "- 观察下一次 ACP 回复。",
      ].join("\n"),
    );
  });

  it("leaves casual replies unchanged", () => {
    expect(formatAcpFinalReportText("我看到了，这个回复确实可以优化。")).toBe(
      "我看到了，这个回复确实可以优化。",
    );
  });

  it("does not rewrite heading-like text inside code fences", () => {
    const input = ["Result:", "```", "Changes:", "Verification:", "```"].join("\n");

    expect(formatAcpFinalReportText(input)).toBe(
      ["✅ 结果", "```", "Changes:", "Verification:", "```"].join("\n"),
    );
  });
});
