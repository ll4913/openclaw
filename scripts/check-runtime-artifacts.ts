#!/usr/bin/env -S node --experimental-strip-types

import { assertCriticalRuntimeArtifactsPresent } from "../src/infra/runtime-artifact-guard.ts";

try {
  const check = assertCriticalRuntimeArtifactsPresent({
    phase: "build",
    commandHint:
      "Re-run `pnpm build` from the OpenClaw checkout. Do not restart the gateway until these files exist.",
  });
  console.error(
    `[check-runtime-artifacts] ok ${check.present.length}/${check.present.length + check.missing.length} required artifact(s) present`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
