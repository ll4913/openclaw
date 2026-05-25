import { describe, expect, it, vi } from "vitest";
import { prefixSystemMessage } from "../../infra/system-message.js";
import { createAcpReplyProjector } from "./acp-projector.js";
import { createAcpTestConfig as createCfg } from "./test-fixtures/acp-runtime.js";

type Delivery = {
  kind: string;
  text?: string;
  meta?: { toolStatus?: string; allowEdit?: boolean };
};

function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let count = 0;
  for (const item of items) {
    if (predicate(item)) {
      count += 1;
    }
  }
  return count;
}

function createProjectorHarness(
  cfgOverrides?: Parameters<typeof createCfg>[0],
  opts?: { onProgress?: () => void },
) {
  const deliveries: Delivery[] = [];
  const projector = createAcpReplyProjector({
    cfg: createCfg(cfgOverrides),
    shouldSendToolSummaries: true,
    deliver: async (kind, payload, meta) => {
      const visibleMeta =
        meta?.toolStatus || meta?.allowEdit != null
          ? {
              ...(meta.toolStatus ? { toolStatus: meta.toolStatus } : {}),
              ...(meta.allowEdit != null ? { allowEdit: meta.allowEdit } : {}),
            }
          : undefined;
      deliveries.push({
        kind,
        text: payload.text,
        ...(visibleMeta ? { meta: visibleMeta } : {}),
      });
      return true;
    },
    onProgress: opts?.onProgress,
  });
  return { deliveries, projector };
}

function createLiveCfgOverrides(
  streamOverrides: Record<string, unknown>,
): Parameters<typeof createCfg>[0] {
  return {
    acp: {
      enabled: true,
      stream: {
        deliveryMode: "live",
        ...streamOverrides,
      },
    },
  } as Parameters<typeof createCfg>[0];
}

function createHiddenBoundaryCfg(
  streamOverrides: Record<string, unknown> = {},
): Parameters<typeof createCfg>[0] {
  return createLiveCfgOverrides({
    coalesceIdleMs: 0,
    maxChunkChars: 256,
    ...streamOverrides,
  });
}

function blockDeliveries(deliveries: Delivery[]) {
  return deliveries.filter((entry) => entry.kind === "block");
}

function combinedBlockText(deliveries: Delivery[]) {
  return blockDeliveries(deliveries)
    .map((entry) => entry.text ?? "")
    .join("");
}

function expectToolCallSummary(delivery: Delivery | undefined) {
  expect(delivery?.kind).toBe("tool");
  expect(delivery?.text).toMatch(
    /Running tests|测试检查没有通过|Tool execution completed|这一步没有跑通|Running tool/i,
  );
  expect(delivery?.text).not.toMatch(/Tool Call|status=/i);
}

function createFinalOnlyStatusToolHarness() {
  return createProjectorHarness({
    acp: {
      enabled: true,
      stream: {
        coalesceIdleMs: 0,
        maxChunkChars: 512,
        deliveryMode: "final_only",
        tagVisibility: {
          available_commands_update: true,
          tool_call: true,
        },
      },
    },
  });
}

function createLiveToolLifecycleHarness(params?: {
  coalesceIdleMs?: number;
  maxChunkChars?: number;
  maxSessionUpdateChars?: number;
  repeatSuppression?: boolean;
}) {
  return createProjectorHarness({
    acp: {
      enabled: true,
      stream: {
        deliveryMode: "live",
        ...params,
        tagVisibility: {
          tool_call: true,
          tool_call_update: true,
        },
      },
    },
  });
}

function createLiveStatusAndToolLifecycleHarness(params?: {
  coalesceIdleMs?: number;
  maxChunkChars?: number;
  repeatSuppression?: boolean;
}) {
  return createProjectorHarness({
    acp: {
      enabled: true,
      stream: {
        deliveryMode: "live",
        ...params,
        tagVisibility: {
          available_commands_update: true,
          tool_call: true,
          tool_call_update: true,
        },
      },
    },
  });
}

async function emitToolLifecycleEvent(
  projector: ReturnType<typeof createProjectorHarness>["projector"],
  event: {
    tag: "tool_call" | "tool_call_update";
    toolCallId: string;
    status: "in_progress" | "completed" | "failed" | "error" | "cancelled";
    title?: string;
    text: string;
  },
) {
  await projector.onEvent({
    type: "tool_call",
    ...event,
  });
}

async function runHiddenBoundaryCase(params: {
  cfgOverrides?: Parameters<typeof createCfg>[0];
  toolCallId: string;
  includeNonTerminalUpdate?: boolean;
  firstText?: string;
  secondText?: string;
  expectedText: string;
}) {
  const { deliveries, projector } = createProjectorHarness(params.cfgOverrides);
  await projector.onEvent({
    type: "text_delta",
    text: params.firstText ?? "fallback.",
    tag: "agent_message_chunk",
  });
  await projector.onEvent({
    type: "tool_call",
    tag: "tool_call",
    toolCallId: params.toolCallId,
    status: "in_progress",
    title: "Run test",
    text: "Run test (in_progress)",
  });
  if (params.includeNonTerminalUpdate) {
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call_update",
      toolCallId: params.toolCallId,
      status: "in_progress",
      title: "Run test",
      text: "Run test (in_progress)",
    });
  }
  await projector.onEvent({
    type: "text_delta",
    text: params.secondText ?? "I don't",
    tag: "agent_message_chunk",
  });
  await projector.flush(true);

  expect(combinedBlockText(deliveries)).toBe(params.expectedText);
}

describe("createAcpReplyProjector", () => {
  it("delivers live MEDIA references as final payloads so attachments are not hidden behind streamed block text", async () => {
    const { deliveries, projector } = createProjectorHarness(
      createLiveCfgOverrides({ coalesceIdleMs: 0, maxChunkChars: 512 }),
    );

    await projector.onEvent({
      type: "text_delta",
      text: "Corrected file ready.\nMEDIA:/tmp/openclaw/out/report.xlsx",
      tag: "agent_message_chunk",
    });
    await projector.flush(true);

    expect(deliveries).toEqual([
      {
        kind: "final",
        text: "Corrected file ready.\nMEDIA:/tmp/openclaw/out/report.xlsx",
      },
    ]);
  });

  it("hides ordinary terminal completions when a visible tool card is already pending", async () => {
    const { deliveries, projector } = createProjectorHarness({
      acp: {
        enabled: true,
        stream: {
          deliveryMode: "live",
          tagVisibility: {
            tool_call: true,
            tool_call_update: false,
          },
        },
      },
    });

    await emitToolLifecycleEvent(projector, {
      tag: "tool_call",
      toolCallId: "read-1",
      status: "in_progress",
      title: "Read File",
      text: "Read File (in_progress)",
    });
    await emitToolLifecycleEvent(projector, {
      tag: "tool_call_update",
      toolCallId: "read-1",
      status: "completed",
      title: "Read File",
      text: "Read File (completed)",
    });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ kind: "tool" });
    expect(deliveries[0]?.text).toContain("Reading files");
    expect(deliveries[0]?.text).not.toMatch(/Tool execution completed|Finished reading files/i);
  });

  it("summarizes visible file reads without leaking raw tool-call status labels", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness();

    await emitToolLifecycleEvent(projector, {
      tag: "tool_call",
      toolCallId: "read-2",
      status: "in_progress",
      title: "Read File",
      text: "Read File, status=pending",
    });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.kind).toBe("tool");
    expect(deliveries[0]?.text).toContain("Reading files");
    expect(deliveries[0]?.text).not.toMatch(/Tool Call|status=pending/i);
  });

  it("summarizes unknown in-progress tools without leaking generic ACP fallback labels", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness();

    await emitToolLifecycleEvent(projector, {
      tag: "tool_call",
      toolCallId: "unknown-1",
      status: "in_progress",
      title: "Custom Tool",
      text: "Custom Tool, status=pending",
    });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.text).toContain("Running tool");
    expect(deliveries[0]?.text).not.toMatch(/Tool Call|status=pending|Custom Tool/i);
  });

  it("does not spam generic tool starts and successful completions as separate visible messages", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness();

    for (let index = 0; index < 4; index += 1) {
      await emitToolLifecycleEvent(projector, {
        tag: "tool_call",
        toolCallId: `generic-${index}`,
        status: "in_progress",
        title: "Custom Tool",
        text: "Custom Tool, status=pending",
      });
      await emitToolLifecycleEvent(projector, {
        tag: "tool_call_update",
        toolCallId: `generic-${index}`,
        status: "completed",
        title: "Custom Tool",
        text: "Custom Tool, status=completed",
      });
    }

    const toolTexts = deliveries
      .filter((entry) => entry.kind === "tool")
      .map((entry) => entry.text ?? "");

    expect(toolTexts.filter((text) => /Running tool/i.test(text))).toHaveLength(1);
    expect(toolTexts.join("\n")).not.toMatch(/Tool execution completed/i);
  });

  it("marks localhost links as local-only candidates and redacts chat-visible credentials", async () => {
    const { deliveries, projector } = createProjectorHarness(
      createLiveCfgOverrides({
        coalesceIdleMs: 0,
        maxChunkChars: 1024,
      }),
    );

    await projector.onEvent({
      type: "text_delta",
      tag: "agent_message_chunk",
      text:
        "好了，代码已接好并在 localhost:3002 浏览器验证通过。\n" +
        "请打开 http://localhost:3002/ops-briefing，用户名 `liang`，密码 `DoNotLeak123`。",
    });
    await projector.flush(true);

    const text = combinedBlockText(deliveries);
    expect(text).toContain("Local verification only");
    expect(text).toContain("Credentials redacted");
    expect(text).not.toContain("DoNotLeak123");
  });

  it("sanitizes breadcrumb-heavy browser validation failures in live tool updates", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness();
    const breadcrumb =
      "run node inline script (heredoc) → run const browser → run const context → run await → run const page → run const → run page.on(request, req → run if → run }) → run await → run await → run const text → run const checks → run text.includes(fy target), → run text.includes(ytd budget), → run console.log(json.stringify({ → run console.log(text.split(n).slice(20,90).join(n)) → run await → run await → run if → run node (repo) failed";

    await emitToolLifecycleEvent(projector, {
      tag: "tool_call_update",
      toolCallId: "browser-check-1",
      status: "failed",
      title: breadcrumb,
      text: breadcrumb,
    });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.kind).toBe("tool");
    expect(deliveries[0]?.text).toContain("页面验证没有通过，正在换方式确认。");
    expect(deliveries[0]?.text).not.toMatch(/heredoc|const browser|page\.on|console\.log|await|→/i);
  });

  it("keeps in-progress tool visibility but summarizes inline browser validation as user-readable progress", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness();

    await emitToolLifecycleEvent(projector, {
      tag: "tool_call",
      toolCallId: "browser-check-2",
      status: "in_progress",
      title: "run node inline script (heredoc)",
      text: "run node inline script (heredoc) → run const browser → run const page",
    });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.kind).toBe("tool");
    expect(deliveries[0]?.text).toContain("Validating page");
    expect(deliveries[0]?.text).not.toMatch(/heredoc|const browser|→/i);
  });

  it("describes ordinary tool failures as a recoverable step instead of a task failure", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness();

    await emitToolLifecycleEvent(projector, {
      tag: "tool_call_update",
      toolCallId: "generic-failed-1",
      status: "failed",
      title: "Custom Tool",
      text: "Custom Tool failed",
    });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.kind).toBe("tool");
    expect(deliveries[0]?.text).toContain("这一步没有跑通，正在继续处理。");
    expect(deliveries[0]?.text).not.toMatch(/Tool execution failed|任务失败/i);
  });

  it("describes build and test tool failures as checks that did not pass", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness();

    await emitToolLifecycleEvent(projector, {
      tag: "tool_call_update",
      toolCallId: "build-failed-1",
      status: "failed",
      title: "Run build",
      text: "pnpm build failed",
    });
    await emitToolLifecycleEvent(projector, {
      tag: "tool_call_update",
      toolCallId: "test-failed-1",
      status: "failed",
      title: "Run tests",
      text: "pnpm test failed",
    });

    const text = deliveries.map((entry) => entry.text ?? "").join("\n");
    expect(text).toContain("构建检查没有通过，正在定位原因。");
    expect(text).toContain("测试检查没有通过，正在定位原因。");
    expect(text).not.toMatch(/Build failed|Tests failed|Tool execution failed/i);
  });

  it("describes typecheck and lint failures as code checks that did not pass", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness();

    await emitToolLifecycleEvent(projector, {
      tag: "tool_call_update",
      toolCallId: "typecheck-failed-1",
      status: "failed",
      title: "Run typecheck",
      text: "pnpm tsgo failed",
    });
    await emitToolLifecycleEvent(projector, {
      tag: "tool_call_update",
      toolCallId: "lint-failed-1",
      status: "failed",
      title: "Run lint",
      text: "pnpm lint failed",
    });

    const text = deliveries.map((entry) => entry.text ?? "").join("\n");
    expect(text).toContain("代码检查没有通过，正在定位原因。");
    expect(text).not.toMatch(/Tool execution failed|任务失败/i);
  });

  it("describes git tool failures as incomplete operations instead of task failure", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness();

    await emitToolLifecycleEvent(projector, {
      tag: "tool_call_update",
      toolCallId: "git-failed-1",
      status: "failed",
      title: "Run git commit",
      text: "git commit failed",
    });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.text).toContain("Git 操作没有完成，正在检查阻塞原因。");
    expect(deliveries[0]?.text).not.toMatch(/Git operation failed|任务失败/i);
  });

  it("describes gateway and ACP check failures as runtime diagnostics", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness();

    await emitToolLifecycleEvent(projector, {
      tag: "tool_call_update",
      toolCallId: "gateway-failed-1",
      status: "failed",
      title: "Run gateway health",
      text: "gateway health failed",
    });
    await emitToolLifecycleEvent(projector, {
      tag: "tool_call_update",
      toolCallId: "acp-status-failed-1",
      status: "failed",
      title: "Run ACP status",
      text: "ACP status failed",
    });

    const text = deliveries.map((entry) => entry.text ?? "").join("\n");
    expect(text).toContain("运行状态检查没有通过，正在继续诊断。");
    expect(text).not.toMatch(/Tool execution failed|任务失败/i);
  });

  it("describes page validation tool failures without implying the whole task failed", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness();

    await emitToolLifecycleEvent(projector, {
      tag: "tool_call_update",
      toolCallId: "browser-check-zh-1",
      status: "failed",
      title: "run node inline script (heredoc)",
      text: "run node inline script (heredoc) → run const browser → run console.log → run node (repo) failed",
    });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.text).toContain("页面验证没有通过，正在换方式确认。");
    expect(deliveries[0]?.text).not.toMatch(
      /Page validation failed|Tool execution failed|heredoc|console\.log|→/i,
    );
  });

  it("allows a final success after a recoverable tool step failure", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness();

    await emitToolLifecycleEvent(projector, {
      tag: "tool_call_update",
      toolCallId: "generic-failed-then-success",
      status: "failed",
      title: "Custom Tool",
      text: "Custom Tool failed",
    });
    await projector.onEvent({
      type: "text_delta",
      tag: "agent_message_chunk",
      text: "已经换一种方式完成了。",
    });
    await projector.flush(true);

    const text = deliveries.map((entry) => entry.text ?? "").join("\n");
    expect(text).toContain("这一步没有跑通，正在继续处理。");
    expect(text).toContain("已经换一种方式完成了。");
    expect(text).not.toMatch(/Tool execution failed|任务失败/i);
  });

  it("adds a visible correction when a validation success claim is followed by a terminal tool failure", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness({
      coalesceIdleMs: 0,
      maxChunkChars: 256,
    });

    await projector.onEvent({
      type: "text_delta",
      text: "已验证通过，页面已经出现 FY TARGET 和 YTD BUDGET。",
      tag: "agent_message_chunk",
    });
    await emitToolLifecycleEvent(projector, {
      tag: "tool_call_update",
      toolCallId: "browser-check-3",
      status: "failed",
      title: "run node inline script (heredoc)",
      text: "run node inline script (heredoc) → run const browser → run console.log → run node (repo) failed",
    });

    const toolText = deliveries
      .filter((entry) => entry.kind === "tool")
      .map((entry) => entry.text ?? "")
      .join("\n");
    expect(toolText).toContain("前面的验证结论需要复核");
    expect(toolText).not.toMatch(/heredoc|const browser|console\.log|→/i);
  });

  it("sanitizes terminal browser validation failures when flushing final-only delivery", async () => {
    const { deliveries, projector } = createProjectorHarness({
      acp: {
        enabled: true,
        stream: {
          deliveryMode: "final_only",
          tagVisibility: {
            tool_call_update: true,
          },
        },
      },
    });

    await emitToolLifecycleEvent(projector, {
      tag: "tool_call_update",
      toolCallId: "browser-check-4",
      status: "failed",
      title: "run node inline script (heredoc)",
      text: "run node inline script (heredoc) → run const browser → run page.on(request, req → run node (repo) failed",
    });
    await projector.flush(true);

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.kind).toBe("tool");
    expect(deliveries[0]?.text).toContain("页面验证没有通过，正在换方式确认。");
    expect(deliveries[0]?.text).not.toMatch(/heredoc|const browser|page\.on|→/i);
  });

  it("sanitizes raw connection JSON errors in assistant text into readable page validation failure", async () => {
    const { deliveries, projector } = createProjectorHarness(
      createLiveCfgOverrides({
        coalesceIdleMs: 0,
        maxChunkChars: 512,
      }),
    );

    await projector.onEvent({
      type: "text_delta",
      tag: "agent_message_chunk",
      text: [
        "验证失败。\n\n",
        "实际请求 http://127.0.0.1:9/not-found 时连接失败：\n\n",
        '```json\n{\n  "error": "EPERM",\n  "message": "connect EPERM 127.0.0.1:9"\n}\n```\n',
        "因此无法确认页面包含 FY TARGET 和 YTD BUDGET。",
      ].join(""),
    });
    await projector.flush(true);

    expect(combinedBlockText(deliveries)).toContain("Page validation failed");
    expect(combinedBlockText(deliveries)).not.toMatch(
      /EPERM|connect EPERM|```json|"error"|"message"/i,
    );
  });

  it("sanitizes plain assistant connection errors into readable page validation failure", async () => {
    const { deliveries, projector } = createProjectorHarness(
      createLiveCfgOverrides({
        coalesceIdleMs: 0,
        maxChunkChars: 512,
      }),
    );

    await projector.onEvent({
      type: "text_delta",
      tag: "agent_message_chunk",
      text:
        "验证失败。\n\n我用 Node 原生 HTTP 实际请求了 `http://127.0.0.1:9/not-found`，结果是：\n\n" +
        "`ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:9`\n\n" +
        "页面没有成功返回内容，所以无法确认其中是否包含 `FY TARGET` 和 `YTD BUDGET`。",
    });
    await projector.flush(true);

    expect(combinedBlockText(deliveries)).toContain("Page validation failed");
    expect(combinedBlockText(deliveries)).not.toMatch(/ECONNREFUSED|connect ECONNREFUSED/i);
  });

  it("sanitizes split assistant connection errors before live buffer delivery", async () => {
    const { deliveries, projector } = createProjectorHarness(
      createLiveCfgOverrides({
        coalesceIdleMs: 0,
        maxChunkChars: 512,
      }),
    );

    await projector.onEvent({
      type: "text_delta",
      tag: "agent_message_chunk",
      text: "验证失败。\n\n我用 Node 原生 HTTP 实际请求了 `http://127.0.0.1:9/not-found`，结果是：\n\n`ECONNREFUSED:",
    });
    await projector.onEvent({
      type: "text_delta",
      tag: "agent_message_chunk",
      text: " connect ECONNREFUSED 127.0.0.1:9`\n\n页面没有成功返回内容，所以无法确认其中是否包含 `FY TARGET` 和 `YTD BUDGET`。",
    });
    await projector.flush(true);

    expect(combinedBlockText(deliveries)).toContain("Page validation failed");
    expect(combinedBlockText(deliveries)).not.toMatch(/ECONNREFUSED|connect ECONNREFUSED/i);
  });

  it("sanitizes assistant connection errors that start with the raw error code", async () => {
    const { deliveries, projector } = createProjectorHarness(
      createLiveCfgOverrides({
        coalesceIdleMs: 0,
        maxChunkChars: 512,
      }),
    );

    await projector.onEvent({
      type: "text_delta",
      tag: "agent_message_chunk",
      text:
        "失败。\n\n我刚才重新用 Node 原生 HTTP 实际请求了：\n\n" +
        "`http://127.0.0.1:9/not-found`\n\n结果：\n\n" +
        "`ECONNREFUSED connect ECONNREFUSED 127.0.0.1:9`\n\n" +
        "所以页面没有返回内容，无法验证是否包含 `FY TARGET` 和 `YTD BUDGET`。",
    });
    await projector.flush(true);

    expect(combinedBlockText(deliveries)).toContain("Page validation failed");
    expect(combinedBlockText(deliveries)).not.toMatch(/ECONNREFUSED|connect ECONNREFUSED/i);
  });

  it("sanitizes plain connection refused assistant text in page validation context", async () => {
    const { deliveries, projector } = createProjectorHarness(
      createLiveCfgOverrides({
        coalesceIdleMs: 0,
        maxChunkChars: 512,
      }),
    );

    await projector.onEvent({
      type: "text_delta",
      tag: "agent_message_chunk",
      text:
        "验证失败。\n\n`curl http://127.0.0.1:9/not-found` 返回 `Couldn't connect to server`，" +
        "`nc -zv 127.0.0.1 9` 返回 `Connection refused`，无法确认 `FY TARGET` 和 `YTD BUDGET`。",
    });
    await projector.flush(true);

    expect(combinedBlockText(deliveries)).toContain("Page validation failed");
    expect(combinedBlockText(deliveries)).not.toMatch(/Connection refused|Couldn't connect/i);
  });

  it("sanitizes raw TLS/OpenSSL assistant text into readable validation failure in final-only delivery", async () => {
    const { deliveries, projector } = createProjectorHarness({
      acp: {
        enabled: true,
        stream: {
          deliveryMode: "final_only",
        },
      },
    });

    await projector.onEvent({
      type: "text_delta",
      tag: "agent_message_chunk",
      text: "Error: T: [internal] COD8F3EE01000000:error:0A000119:SSL routines:tls_get_more_records:decryption failed or bad record mac:../deps/openssl/openssl/ssl/record/methods/tls_common.c:870:",
    });
    await projector.flush(true);

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.kind).toBe("final");
    expect(deliveries[0]?.text).toContain("Validation failed");
    expect(deliveries[0]?.text).not.toMatch(
      /SSL routines|tls_get_more_records|bad record mac|openssl/i,
    );
  });

  it("reports progress for ACP runtime events before delivery filtering", async () => {
    const onProgress = vi.fn();
    const { projector } = createProjectorHarness(undefined, { onProgress });

    await projector.onEvent({
      type: "text_delta",
      stream: "thought",
      text: "hidden reasoning",
      tag: "agent_message_chunk",
    });
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "tool-1",
      status: "in_progress",
      title: "Run command",
      text: "Run command",
    });

    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it("buffers default final-only text into one final reply", async () => {
    const { deliveries, projector } = createProjectorHarness();

    await projector.onEvent({
      type: "text_delta",
      text: "a".repeat(70),
      tag: "agent_message_chunk",
    });
    await projector.flush(true);

    expect(deliveries).toEqual([{ kind: "final", text: "a".repeat(70) }]);
  });

  it("does not suppress identical short text across terminal turn boundaries", async () => {
    const { deliveries, projector } = createProjectorHarness(
      createLiveCfgOverrides({
        coalesceIdleMs: 0,
        maxChunkChars: 64,
      }),
    );

    await projector.onEvent({ type: "text_delta", text: "A", tag: "agent_message_chunk" });
    await projector.onEvent({ type: "done", stopReason: "end_turn" });
    await projector.onEvent({ type: "text_delta", text: "A", tag: "agent_message_chunk" });
    await projector.onEvent({ type: "done", stopReason: "end_turn" });

    expect(blockDeliveries(deliveries)).toEqual([
      { kind: "block", text: "A" },
      { kind: "block", text: "A" },
    ]);
  });

  it("flushes staggered live text deltas after idle gaps", async () => {
    vi.useFakeTimers();
    try {
      const { deliveries, projector } = createProjectorHarness(
        createLiveCfgOverrides({
          coalesceIdleMs: 50,
          maxChunkChars: 64,
        }),
      );

      await projector.onEvent({ type: "text_delta", text: "A", tag: "agent_message_chunk" });
      await vi.advanceTimersByTimeAsync(760);
      await projector.flush(false);

      await projector.onEvent({ type: "text_delta", text: "B", tag: "agent_message_chunk" });
      await vi.advanceTimersByTimeAsync(760);
      await projector.flush(false);

      await projector.onEvent({ type: "text_delta", text: "C", tag: "agent_message_chunk" });
      await vi.advanceTimersByTimeAsync(760);
      await projector.flush(false);

      expect(blockDeliveries(deliveries)).toEqual([
        { kind: "block", text: "A" },
        { kind: "block", text: "B" },
        { kind: "block", text: "C" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("splits oversized live text by maxChunkChars", async () => {
    const { deliveries, projector } = createProjectorHarness({
      acp: {
        enabled: true,
        stream: {
          deliveryMode: "live",
          coalesceIdleMs: 0,
          maxChunkChars: 50,
        },
      },
    });

    const text = `${"a".repeat(50)}${"b".repeat(50)}${"c".repeat(20)}`;
    await projector.onEvent({ type: "text_delta", text, tag: "agent_message_chunk" });
    await projector.flush(true);

    expect(blockDeliveries(deliveries)).toEqual([
      { kind: "block", text: "a".repeat(50) },
      { kind: "block", text: "b".repeat(50) },
      { kind: "block", text: "c".repeat(20) },
    ]);
  });

  it("does not flush short live fragments mid-phrase on idle", async () => {
    vi.useFakeTimers();
    try {
      const { deliveries, projector } = createProjectorHarness(
        createLiveCfgOverrides({
          coalesceIdleMs: 100,
          maxChunkChars: 256,
        }),
      );

      await projector.onEvent({
        type: "text_delta",
        text: "Yes. Send me the term(s), and I’ll run ",
        tag: "agent_message_chunk",
      });

      await vi.advanceTimersByTimeAsync(1200);
      expect(deliveries).toStrictEqual([]);

      await projector.onEvent({
        type: "text_delta",
        text: "`wd-cli` searches right away. ",
        tag: "agent_message_chunk",
      });
      await projector.flush(false);

      expect(deliveries).toEqual([
        {
          kind: "block",
          text: "Yes. Send me the term(s), and I’ll run `wd-cli` searches right away. ",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports deliveryMode=final_only by buffering all projected output until done", async () => {
    const { deliveries, projector } = createFinalOnlyStatusToolHarness();

    await projector.onEvent({
      type: "text_delta",
      text: "What",
      tag: "agent_message_chunk",
    });
    await projector.onEvent({
      type: "status",
      text: "available commands updated (7)",
      tag: "available_commands_update",
    });
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "call_1",
      status: "in_progress",
      title: "List files",
      text: "List files (in_progress)",
    });
    await projector.onEvent({
      type: "text_delta",
      text: " now?",
      tag: "agent_message_chunk",
    });
    expect(deliveries).toStrictEqual([]);

    await projector.onEvent({ type: "done" });
    expect(deliveries).toHaveLength(3);
    expect(deliveries[0]).toEqual({
      kind: "tool",
      text: prefixSystemMessage("available commands updated (7)"),
    });
    expectToolCallSummary(deliveries[1]);
    expect(deliveries[2]).toEqual({ kind: "final", text: "What now?" });
  });

  it("flushes buffered status/tool output on error in deliveryMode=final_only", async () => {
    const { deliveries, projector } = createFinalOnlyStatusToolHarness();

    await projector.onEvent({
      type: "status",
      text: "available commands updated (7)",
      tag: "available_commands_update",
    });
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "call_2",
      status: "in_progress",
      title: "Run tests",
      text: "Run tests (in_progress)",
    });
    expect(deliveries).toStrictEqual([]);

    await projector.onEvent({ type: "error", message: "turn failed" });
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toEqual({
      kind: "tool",
      text: prefixSystemMessage("available commands updated (7)"),
    });
    expectToolCallSummary(deliveries[1]);
  });

  it("suppresses usage_update by default and allows deduped usage when tag-visible", async () => {
    const { deliveries: hidden, projector: hiddenProjector } = createProjectorHarness();
    await hiddenProjector.onEvent({
      type: "status",
      text: "usage updated: 10/100",
      tag: "usage_update",
      used: 10,
      size: 100,
    });
    expect(hidden).toStrictEqual([]);

    const { deliveries: shown, projector: shownProjector } = createProjectorHarness(
      createLiveCfgOverrides({
        coalesceIdleMs: 0,
        maxChunkChars: 64,
        tagVisibility: {
          usage_update: true,
        },
      }),
    );

    await shownProjector.onEvent({
      type: "status",
      text: "usage updated: 10/100",
      tag: "usage_update",
      used: 10,
      size: 100,
    });
    await shownProjector.onEvent({
      type: "status",
      text: "usage updated: 10/100",
      tag: "usage_update",
      used: 10,
      size: 100,
    });
    await shownProjector.onEvent({
      type: "status",
      text: "usage updated: 11/100",
      tag: "usage_update",
      used: 11,
      size: 100,
    });

    expect(shown).toEqual([
      { kind: "tool", text: prefixSystemMessage("usage updated: 10/100") },
      { kind: "tool", text: prefixSystemMessage("usage updated: 11/100") },
    ]);
  });

  it("hides available_commands_update by default", async () => {
    const { deliveries, projector } = createProjectorHarness();
    await projector.onEvent({
      type: "status",
      text: "available commands updated (7)",
      tag: "available_commands_update",
    });

    expect(deliveries).toStrictEqual([]);
  });

  it("shows in-progress tool calls by default without raw ACP labels", async () => {
    const { deliveries, projector } = createProjectorHarness(
      createLiveCfgOverrides({
        coalesceIdleMs: 0,
        maxChunkChars: 256,
      }),
    );

    await emitToolLifecycleEvent(projector, {
      tag: "tool_call",
      toolCallId: "default-visible-1",
      status: "in_progress",
      title: "Read File",
      text: "Read File, status=pending",
    });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.text).toContain("Reading files");
    expect(deliveries[0]?.text).not.toMatch(/Tool Call|status=pending/i);
  });

  it("dedupes repeated tool lifecycle updates when repeatSuppression is enabled", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness();

    await emitToolLifecycleEvent(projector, {
      tag: "tool_call",
      toolCallId: "call_1",
      status: "in_progress",
      title: "List files",
      text: "List files (in_progress)",
    });
    await emitToolLifecycleEvent(projector, {
      tag: "tool_call_update",
      toolCallId: "call_1",
      status: "in_progress",
      title: "List files",
      text: "List files (in_progress)",
    });
    await emitToolLifecycleEvent(projector, {
      tag: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      title: "List files",
      text: "List files (completed)",
    });
    await emitToolLifecycleEvent(projector, {
      tag: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      title: "List files",
      text: "List files (completed)",
    });

    expect(deliveries.length).toBe(1);
    expectToolCallSummary(deliveries[0]);
  });

  it("keeps terminal tool failures even when rendered summaries are truncated", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness({
      maxSessionUpdateChars: 48,
    });

    const longTitle =
      "Run an intentionally long command title that truncates before lifecycle status is visible";
    await emitToolLifecycleEvent(projector, {
      tag: "tool_call",
      toolCallId: "call_truncated_status",
      status: "in_progress",
      title: longTitle,
      text: `${longTitle} (in_progress)`,
    });
    await emitToolLifecycleEvent(projector, {
      tag: "tool_call_update",
      toolCallId: "call_truncated_status",
      status: "failed",
      title: longTitle,
      text: `${longTitle} (failed)`,
    });

    expect(deliveries.length).toBe(2);
    expectToolCallSummary(deliveries[0]);
    expectToolCallSummary(deliveries[1]);
  });

  it("renders fallback tool labels without leaking call ids as primary label", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness();

    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "call_ABC123",
      status: "in_progress",
      text: "call_ABC123 (in_progress)",
    });

    expectToolCallSummary(deliveries[0]);
    expect(deliveries[0]?.text).not.toContain("call_ABC123 (");
  });

  it("allows repeated status/tool summaries when repeatSuppression is disabled", async () => {
    const { deliveries, projector } = createLiveStatusAndToolLifecycleHarness({
      coalesceIdleMs: 0,
      maxChunkChars: 256,
      repeatSuppression: false,
    });

    await projector.onEvent({
      type: "status",
      text: "available commands updated",
      tag: "available_commands_update",
    });
    await projector.onEvent({
      type: "status",
      text: "available commands updated",
      tag: "available_commands_update",
    });
    await projector.onEvent({
      type: "tool_call",
      text: "tool call",
      tag: "tool_call",
      toolCallId: "x",
      status: "in_progress",
    });
    await projector.onEvent({
      type: "tool_call",
      text: "tool call",
      tag: "tool_call_update",
      toolCallId: "x",
      status: "in_progress",
    });
    await projector.onEvent({
      type: "text_delta",
      text: "hello",
      tag: "agent_message_chunk",
    });
    await projector.flush(true);

    expect(countMatching(deliveries, (entry) => entry.kind === "tool")).toBe(4);
    expect(deliveries[0]).toEqual({
      kind: "tool",
      text: prefixSystemMessage("available commands updated"),
    });
    expect(deliveries[1]).toEqual({
      kind: "tool",
      text: prefixSystemMessage("available commands updated"),
    });
    expectToolCallSummary(deliveries[2]);
    expectToolCallSummary(deliveries[3]);
    expect(deliveries[4]).toEqual({ kind: "block", text: "hello" });
  });

  it("suppresses exact duplicate status updates when repeatSuppression is enabled", async () => {
    const { deliveries, projector } = createProjectorHarness(
      createLiveCfgOverrides({
        coalesceIdleMs: 0,
        maxChunkChars: 256,
        tagVisibility: {
          available_commands_update: true,
        },
      }),
    );

    await projector.onEvent({
      type: "status",
      text: "available commands updated (7)",
      tag: "available_commands_update",
    });
    await projector.onEvent({
      type: "status",
      text: "available commands updated (7)",
      tag: "available_commands_update",
    });
    await projector.onEvent({
      type: "status",
      text: "available commands updated (8)",
      tag: "available_commands_update",
    });

    expect(deliveries).toEqual([
      { kind: "tool", text: prefixSystemMessage("available commands updated (7)") },
      { kind: "tool", text: prefixSystemMessage("available commands updated (8)") },
    ]);
  });

  it("truncates oversized turns once and emits one truncation notice", async () => {
    const { deliveries, projector } = createProjectorHarness({
      acp: {
        enabled: true,
        stream: {
          coalesceIdleMs: 0,
          maxChunkChars: 256,
          deliveryMode: "live",
          maxOutputChars: 5,
        },
      },
    });

    await projector.onEvent({
      type: "text_delta",
      text: "hello world",
      tag: "agent_message_chunk",
    });
    await projector.onEvent({
      type: "text_delta",
      text: "ignored tail",
      tag: "agent_message_chunk",
    });
    await projector.flush(true);

    expect(deliveries).toEqual([
      { kind: "block", text: "hello" },
      {
        kind: "tool",
        text: prefixSystemMessage("output truncated"),
      },
    ]);
  });

  it("supports tagVisibility overrides for tool updates", async () => {
    const { deliveries, projector } = createProjectorHarness({
      acp: {
        enabled: true,
        stream: {
          coalesceIdleMs: 0,
          maxChunkChars: 256,
          deliveryMode: "live",
          tagVisibility: {
            tool_call: true,
            tool_call_update: false,
          },
        },
      },
    });

    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "c1",
      status: "in_progress",
      title: "Run tests",
      text: "Run tests (in_progress)",
    });
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call_update",
      toolCallId: "c1",
      status: "failed",
      title: "Run tests",
      text: "Run tests (failed)",
    });

    expect(deliveries.length).toBe(2);
    expectToolCallSummary(deliveries[0]);
    expect(deliveries[1]).toMatchObject({
      kind: "tool",
      meta: { toolStatus: "failed", allowEdit: true },
    });
    expect(deliveries[1]?.text).toContain("测试检查没有通过，正在定位原因。");
    expect(deliveries[1]?.text).not.toMatch(/Tool Call|status=/i);
  });

  it("inserts a space boundary before visible text after hidden tool updates", async () => {
    await runHiddenBoundaryCase({
      cfgOverrides: createHiddenBoundaryCfg({
        tagVisibility: {
          tool_call: false,
          tool_call_update: false,
        },
      }),
      toolCallId: "call_hidden_1",
      expectedText: "fallback. I don't",
    });
  });

  it("preserves hidden boundary across nonterminal hidden tool updates", async () => {
    await runHiddenBoundaryCase({
      cfgOverrides: createHiddenBoundaryCfg({
        tagVisibility: {
          tool_call: false,
          tool_call_update: false,
        },
      }),
      toolCallId: "hidden_boundary_1",
      includeNonTerminalUpdate: true,
      expectedText: "fallback. I don't",
    });
  });

  it("supports hiddenBoundarySeparator=space", async () => {
    await runHiddenBoundaryCase({
      cfgOverrides: createHiddenBoundaryCfg({
        hiddenBoundarySeparator: "space",
        tagVisibility: {
          tool_call: false,
          tool_call_update: false,
        },
      }),
      toolCallId: "call_hidden_2",
      expectedText: "fallback. I don't",
    });
  });

  it("supports hiddenBoundarySeparator=none", async () => {
    await runHiddenBoundaryCase({
      cfgOverrides: createHiddenBoundaryCfg({
        hiddenBoundarySeparator: "none",
        tagVisibility: {
          tool_call: false,
          tool_call_update: false,
        },
      }),
      toolCallId: "call_hidden_3",
      expectedText: "fallback.I don't",
    });
  });

  it("does not duplicate newlines when previous visible text already ends with newline", async () => {
    await runHiddenBoundaryCase({
      cfgOverrides: createHiddenBoundaryCfg({
        tagVisibility: {
          tool_call: false,
          tool_call_update: false,
        },
      }),
      toolCallId: "call_hidden_4",
      firstText: "fallback.\n",
      expectedText: "fallback.\nI don't",
    });
  });

  it("does not insert boundary separator for hidden non-tool status updates", async () => {
    const { deliveries, projector } = createProjectorHarness({
      acp: {
        enabled: true,
        stream: {
          coalesceIdleMs: 0,
          maxChunkChars: 256,
          deliveryMode: "live",
        },
      },
    });

    await projector.onEvent({ type: "text_delta", text: "A", tag: "agent_message_chunk" });
    await projector.onEvent({
      type: "status",
      tag: "available_commands_update",
      text: "available commands updated",
    });
    await projector.onEvent({ type: "text_delta", text: "B", tag: "agent_message_chunk" });
    await projector.flush(true);

    expect(combinedBlockText(deliveries)).toBe("AB");
  });
});
