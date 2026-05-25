import { statSync } from "node:fs";
import path from "node:path";

export const CRITICAL_RUNTIME_ARTIFACTS = [
  "dist/index.js",
  "dist/entry.js",
  "dist/telegram-ingress-worker.runtime.js",
  "dist/agents/auth-profiles.runtime.js",
  "dist/plugin-sdk/state-paths.js",
  "dist/plugin-sdk/account-id.js",
  "dist/plugin-sdk/channel-entry-contract.js",
] as const;

type StatSync = typeof statSync;

export type RuntimeArtifactCheck = {
  rootDir: string;
  present: string[];
  missing: string[];
  ok: boolean;
};

function hasFile(relativePath: string, rootDir: string, statSyncImpl: StatSync): boolean {
  try {
    return statSyncImpl(path.join(rootDir, relativePath)).isFile();
  } catch {
    return false;
  }
}

export function checkCriticalRuntimeArtifacts(
  params: {
    rootDir?: string;
    statSync?: StatSync;
  } = {},
): RuntimeArtifactCheck {
  const rootDir = path.resolve(params.rootDir ?? process.cwd());
  const statSyncImpl = params.statSync ?? statSync;
  const present: string[] = [];
  const missing: string[] = [];

  for (const relativePath of CRITICAL_RUNTIME_ARTIFACTS) {
    if (hasFile(relativePath, rootDir, statSyncImpl)) {
      present.push(relativePath);
    } else {
      missing.push(relativePath);
    }
  }

  return {
    rootDir,
    present,
    missing,
    ok: missing.length === 0,
  };
}

export function formatRuntimeArtifactFailure(
  check: RuntimeArtifactCheck,
  params: { phase?: "build" | "gateway-startup" | "runtime"; commandHint?: string } = {},
): string {
  const phase =
    params.phase === "build"
      ? "after build"
      : params.phase === "gateway-startup"
        ? "before gateway startup"
        : "at runtime";
  const hint =
    params.commandHint ?? "Run `pnpm build` from the OpenClaw checkout, then restart the gateway.";
  return [
    `OpenClaw runtime artifact check failed ${phase}.`,
    `Root: ${check.rootDir}`,
    "Missing required artifact(s):",
    ...check.missing.map((relativePath) => `- ${relativePath}`),
    hint,
  ].join("\n");
}

export function assertCriticalRuntimeArtifactsPresent(
  params: {
    rootDir?: string;
    statSync?: StatSync;
    phase?: "build" | "gateway-startup" | "runtime";
    commandHint?: string;
  } = {},
): RuntimeArtifactCheck {
  const check = checkCriticalRuntimeArtifacts(params);
  if (!check.ok) {
    throw new Error(formatRuntimeArtifactFailure(check, params));
  }
  return check;
}

export function resolveRuntimeArtifactRootFromEntrypoint(
  entrypoint: string | undefined,
): string | null {
  if (!entrypoint) {
    return null;
  }
  const resolved = path.resolve(entrypoint);
  const parts = resolved.split(path.sep);
  const distIndex = parts.lastIndexOf("dist");
  if (distIndex <= 0) {
    return null;
  }
  return parts.slice(0, distIndex).join(path.sep) || path.parse(resolved).root;
}

export function assertGatewayStartupRuntimeArtifactsPresent(
  params: {
    argv1?: string;
    rootDir?: string;
    statSync?: StatSync;
  } = {},
): RuntimeArtifactCheck | null {
  const rootDir =
    params.rootDir ?? resolveRuntimeArtifactRootFromEntrypoint(params.argv1 ?? process.argv[1]);
  if (!rootDir) {
    return null;
  }
  return assertCriticalRuntimeArtifactsPresent({
    rootDir,
    statSync: params.statSync,
    phase: "gateway-startup",
    commandHint:
      "A build or upgrade may have removed live runtime files. Stop the gateway, run `pnpm build`, then start the gateway again.",
  });
}
