import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CRITICAL_RUNTIME_ARTIFACTS,
  assertCriticalRuntimeArtifactsPresent,
  assertGatewayStartupRuntimeArtifactsPresent,
  checkCriticalRuntimeArtifacts,
  resolveRuntimeArtifactRootFromEntrypoint,
} from "./runtime-artifact-guard.js";

function withRuntimeArtifactFixture(
  run: (fixture: { rootDir: string; writeArtifact: (relativePath: string) => void }) => void,
) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-artifacts-"));
  try {
    run({
      rootDir,
      writeArtifact(relativePath: string) {
        const filePath = path.join(rootDir, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, "artifact\n");
      },
    });
  } finally {
    fs.rmSync(rootDir, { force: true, recursive: true });
  }
}

describe("runtime artifact guard", () => {
  it("passes when every critical runtime artifact is present", () => {
    withRuntimeArtifactFixture(({ rootDir, writeArtifact }) => {
      for (const relativePath of CRITICAL_RUNTIME_ARTIFACTS) {
        writeArtifact(relativePath);
      }

      const check = checkCriticalRuntimeArtifacts({ rootDir });

      expect(check.ok).toBe(true);
      expect(check.missing).toEqual([]);
      expect(check.present).toEqual([...CRITICAL_RUNTIME_ARTIFACTS]);
      expect(() => assertCriticalRuntimeArtifactsPresent({ rootDir })).not.toThrow();
    });
  });

  it("reports every missing critical runtime artifact with a readable build hint", () => {
    withRuntimeArtifactFixture(({ rootDir, writeArtifact }) => {
      writeArtifact("dist/index.js");

      const check = checkCriticalRuntimeArtifacts({ rootDir });

      expect(check.ok).toBe(false);
      expect(check.missing).toContain("dist/telegram-ingress-worker.runtime.js");
      expect(() => assertCriticalRuntimeArtifactsPresent({ rootDir, phase: "build" })).toThrow(
        /OpenClaw runtime artifact check failed after build/u,
      );
    });
  });

  it("resolves the package root from a dist entrypoint", () => {
    expect(resolveRuntimeArtifactRootFromEntrypoint("/opt/openclaw/dist/index.js")).toBe(
      "/opt/openclaw",
    );
    expect(
      resolveRuntimeArtifactRootFromEntrypoint("/opt/openclaw/scripts/run-node.mjs"),
    ).toBeNull();
  });

  it("skips gateway startup checks for source runners and fails dist startup checks clearly", () => {
    withRuntimeArtifactFixture(({ rootDir, writeArtifact }) => {
      writeArtifact("dist/index.js");

      expect(
        assertGatewayStartupRuntimeArtifactsPresent({
          argv1: path.join(rootDir, "scripts/run-node.mjs"),
        }),
      ).toBeNull();
      expect(() =>
        assertGatewayStartupRuntimeArtifactsPresent({
          argv1: path.join(rootDir, "dist/index.js"),
        }),
      ).toThrow(/before gateway startup/u);
    });
  });
});
