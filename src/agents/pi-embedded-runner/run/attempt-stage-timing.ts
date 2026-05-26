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

export type EmbeddedRunPrepBudgetOptions = {
  totalBudgetMs?: number;
  defaultStageBudgetMs?: number;
  stageBudgetsMs?: Record<string, number>;
};

export type EmbeddedRunPrepBudgetBreach =
  | {
      kind: "total";
      key: "total";
      actualMs: number;
      budgetMs: number;
      overByMs: number;
    }
  | {
      kind: "stage";
      key: string;
      stage: EmbeddedRunStageTiming;
      actualMs: number;
      budgetMs: number;
      overByMs: number;
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

const EMBEDDED_RUN_PREP_TOTAL_BUDGET_MS = 20_000;
const EMBEDDED_RUN_PREP_STAGE_BUDGET_MS = 10_000;
const EMBEDDED_RUN_PREP_STAGE_BUDGETS_MS: Readonly<Record<string, number>> = {
  "bootstrap-files": 8_000,
  "bootstrap-context": 8_000,
  "bundle-mcp-runtime": 8_000,
  "bundle-mcp-tools": 8_000,
  "bundle-lsp-tools": 8_000,
  "bundle-tools": 8_000,
  "context-engine-bootstrap": 8_000,
  "session-resource-loader": 8_000,
};

function normalizeBudgetMs(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

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

export function findEmbeddedRunPrepBudgetBreaches(
  summary: EmbeddedRunStageSummary,
  options?: EmbeddedRunPrepBudgetOptions,
): EmbeddedRunPrepBudgetBreach[] {
  const totalBudgetMs = normalizeBudgetMs(
    options?.totalBudgetMs,
    EMBEDDED_RUN_PREP_TOTAL_BUDGET_MS,
  );
  const defaultStageBudgetMs = normalizeBudgetMs(
    options?.defaultStageBudgetMs,
    EMBEDDED_RUN_PREP_STAGE_BUDGET_MS,
  );
  const stageBudgets = {
    ...EMBEDDED_RUN_PREP_STAGE_BUDGETS_MS,
    ...(options?.stageBudgetsMs ?? {}),
  };
  const breaches: EmbeddedRunPrepBudgetBreach[] = [];
  if (summary.totalMs >= totalBudgetMs) {
    breaches.push({
      kind: "total",
      key: "total",
      actualMs: summary.totalMs,
      budgetMs: totalBudgetMs,
      overByMs: summary.totalMs - totalBudgetMs,
    });
  }
  for (const stage of summary.stages) {
    const stageBudgetMs = normalizeBudgetMs(stageBudgets[stage.name], defaultStageBudgetMs);
    if (stage.durationMs < stageBudgetMs) {
      continue;
    }
    breaches.push({
      kind: "stage",
      key: `stage:${stage.name}`,
      stage,
      actualMs: stage.durationMs,
      budgetMs: stageBudgetMs,
      overByMs: stage.durationMs - stageBudgetMs,
    });
  }
  return breaches;
}

export function formatEmbeddedRunPrepBudgetBreach(
  prefix: string,
  breach: EmbeddedRunPrepBudgetBreach,
): string {
  if (breach.kind === "total") {
    return `${prefix} kind=total actualMs=${breach.actualMs} budgetMs=${breach.budgetMs} overByMs=${breach.overByMs}`;
  }
  return (
    `${prefix} kind=stage stage=${breach.stage.name} actualMs=${breach.actualMs}` +
    ` budgetMs=${breach.budgetMs} overByMs=${breach.overByMs} elapsedMs=${breach.stage.elapsedMs}`
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
