export type EmbeddedRunStageTiming = {
  name: string;
  durationMs: number;
  elapsedMs: number;
};

export type EmbeddedRunStageSummary = {
  totalMs: number;
  stages: EmbeddedRunStageTiming[];
};

export type EmbeddedRunStageTracker = {
  mark: (name: string) => void;
  snapshot: () => EmbeddedRunStageSummary;
};

export type EmbeddedRunPrepYieldOptions = {
  yieldNow?: () => Promise<void>;
};

export type EmbeddedRunPrepProgressLogOptions = {
  reason: string;
  summary: EmbeddedRunStageSummary;
  traceEnabled?: boolean;
  elapsedThresholdMs?: number;
};

export const EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE = {
  workspace: "attempt-workspace",
  prompt: "attempt-prompt",
  runtimePlan: "attempt-runtime-plan",
  dispatch: "attempt-dispatch",
} as const;

const EMBEDDED_RUN_STAGE_WARN_TOTAL_MS = 10_000;
const EMBEDDED_RUN_STAGE_WARN_STAGE_MS = 5_000;
const EMBEDDED_RUN_PREP_PROGRESS_LOG_ELAPSED_MS = 1_000;

export function createEmbeddedRunStageTracker(options?: {
  now?: () => number;
}): EmbeddedRunStageTracker {
  const now = options?.now ?? Date.now;
  const startedAt = now();
  let previousAt = startedAt;
  const stages: EmbeddedRunStageTiming[] = [];

  const toMs = (value: number) => Math.max(0, Math.round(value));

  return {
    mark(name) {
      const currentAt = now();
      stages.push({
        name,
        durationMs: toMs(currentAt - previousAt),
        elapsedMs: toMs(currentAt - startedAt),
      });
      previousAt = currentAt;
    },
    snapshot() {
      return {
        totalMs: toMs(now() - startedAt),
        stages: stages.slice(),
      };
    },
  };
}

export async function yieldEmbeddedRunPrep(options?: EmbeddedRunPrepYieldOptions): Promise<void> {
  if (options?.yieldNow) {
    await options.yieldNow();
    return;
  }
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export function shouldLogEmbeddedRunPrepProgress(
  options: EmbeddedRunPrepProgressLogOptions,
): boolean {
  if (options.traceEnabled) {
    return true;
  }
  if (options.reason.endsWith("-start")) {
    return true;
  }
  const thresholdMs = options.elapsedThresholdMs ?? EMBEDDED_RUN_PREP_PROGRESS_LOG_ELAPSED_MS;
  return options.summary.totalMs >= thresholdMs;
}

export function formatEmbeddedRunPrepProgress(
  prefix: string,
  options: Pick<EmbeddedRunPrepProgressLogOptions, "reason" | "summary">,
): string {
  const lastStage = options.summary.stages.at(-1);
  const lastStageText = lastStage
    ? ` lastStage=${lastStage.name}:${lastStage.durationMs}ms@${lastStage.elapsedMs}ms`
    : "";
  return `${prefix} reason=${options.reason} elapsedMs=${options.summary.totalMs}${lastStageText}`;
}

export function shouldWarnEmbeddedRunStageSummary(
  summary: EmbeddedRunStageSummary,
  options?: {
    totalThresholdMs?: number;
    stageThresholdMs?: number;
  },
): boolean {
  const totalThresholdMs = options?.totalThresholdMs ?? EMBEDDED_RUN_STAGE_WARN_TOTAL_MS;
  const stageThresholdMs = options?.stageThresholdMs ?? EMBEDDED_RUN_STAGE_WARN_STAGE_MS;
  return (
    summary.totalMs >= totalThresholdMs ||
    summary.stages.some((stage) => stage.durationMs >= stageThresholdMs)
  );
}

export function formatEmbeddedRunStageSummary(
  prefix: string,
  summary: EmbeddedRunStageSummary,
): string {
  const stages =
    summary.stages.length > 0
      ? summary.stages
          .map((stage) => `${stage.name}:${stage.durationMs}ms@${stage.elapsedMs}ms`)
          .join(",")
      : "none";
  return `${prefix} totalMs=${summary.totalMs} stages=${stages}`;
}
