import { normalizeOptionalString } from "../../shared/string-coerce.js";

type ReportSection = {
  icon: string;
  label: string;
  patterns: readonly RegExp[];
};

const REPORT_SECTIONS: readonly ReportSection[] = [
  {
    icon: "✅",
    label: "结果",
    patterns: [
      /^(?:result|outcome|summary|status|completion|completed|done)$/iu,
      /^(?:结果|结论|状态|完成|完成情况|已完成)$/u,
    ],
  },
  {
    icon: "🔧",
    label: "改动",
    patterns: [
      /^(?:changes?|updates?|fix(?:es)?|implementation|work done|what changed)$/iu,
      /^(?:改动|变更|修复|处理内容|做了什么|已处理)$/u,
    ],
  },
  {
    icon: "🧪",
    label: "验证",
    patterns: [
      /^(?:verification|validation|tests?|checks?|qa|proof|evidence)$/iu,
      /^(?:验证|验证结果|测试|检查|校验|证据)$/u,
    ],
  },
  {
    icon: "⚠️",
    label: "注意",
    patterns: [
      /^(?:notes?|risks?|caveats?|limitations?|known issues?|remaining risks?|attention)$/iu,
      /^(?:注意|风险|限制|问题|剩余风险|已知问题)$/u,
    ],
  },
  {
    icon: "➡️",
    label: "下一步",
    patterns: [
      /^(?:next(?: steps?)?|follow[- ]?ups?|todo|next action)$/iu,
      /^(?:下一步|后续|待办|建议)$/u,
    ],
  },
  {
    icon: "📄",
    label: "文件",
    patterns: [
      /^(?:files?|changed files?|artifacts?|outputs?|deliverables?)$/iu,
      /^(?:文件|产物|交付物)$/u,
    ],
  },
  {
    icon: "🚧",
    label: "阻塞",
    patterns: [/^(?:blocked|blockers?|failure|failed|errors?)$/iu, /^(?:阻塞|失败|错误)$/u],
  },
];

const KNOWN_SECTION_ICONS = /^(?:✅|🔧|🧪|⚠️|➡️|📄|🚧|📌|🔍)\s*/u;

function stripMarkdownHeading(rawLine: string): {
  text: string;
  headingLike: boolean;
} {
  const trimmed = rawLine.trim();
  let text = trimmed;
  let headingLike = false;

  const markdownHeading = text.match(/^#{1,6}\s+(.+)$/u);
  if (markdownHeading?.[1]) {
    text = markdownHeading[1].trim();
    headingLike = true;
  }

  const listHeading = text.match(/^(?:[-*]\s+|\d+[.)]\s+)(.+)$/u);
  if (listHeading?.[1]) {
    text = listHeading[1].trim();
  }

  const boldHeading = text.match(/^(?:\*\*|__)(.+?)(?:\*\*|__)$/u);
  if (boldHeading?.[1]) {
    text = boldHeading[1].trim();
    headingLike = true;
  }

  const hasTrailingColon = /[:：]\s*$/u.test(text);
  text = text
    .replace(KNOWN_SECTION_ICONS, "")
    .replace(/[:：]\s*$/u, "")
    .trim();

  return { text, headingLike: headingLike || hasTrailingColon };
}

function classifyReportSection(rawLine: string): ReportSection | null {
  const { text, headingLike } = stripMarkdownHeading(rawLine);
  const normalized = normalizeOptionalString(text);
  if (!normalized || normalized.length > 48) {
    return null;
  }
  if (!headingLike && /\s/u.test(normalized) && normalized.length > 24) {
    return null;
  }
  return (
    REPORT_SECTIONS.find((section) =>
      section.patterns.some((pattern) => pattern.test(normalized)),
    ) ?? null
  );
}

function shouldToggleCodeFence(line: string): boolean {
  return /^\s*(?:```|~~~)/u.test(line);
}

export function formatAcpFinalReportText(input: string): string {
  const text = normalizeOptionalString(input);
  if (!text) {
    return input;
  }

  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const formatted: string[] = [];
  let inCodeFence = false;
  let changedHeadings = 0;

  for (const line of lines) {
    if (shouldToggleCodeFence(line)) {
      formatted.push(line);
      inCodeFence = !inCodeFence;
      continue;
    }

    const section = inCodeFence ? null : classifyReportSection(line);
    if (!section) {
      formatted.push(line);
      continue;
    }

    if (formatted.length > 0 && normalizeOptionalString(formatted[formatted.length - 1])) {
      formatted.push("");
    }
    formatted.push(`${section.icon} ${section.label}`);
    changedHeadings += 1;
  }

  if (changedHeadings === 0) {
    return input;
  }

  return formatted
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
