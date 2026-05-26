import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcAcpSpawnCwd } from "./acp-cwd-redirect.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeMcRepo(params: {
  defaultCheckout: string;
  bindingKey?: string;
  redirectedCwd?: string;
}): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "mc-repo-"));
  tempDirs.push(repo);
  const scriptsDir = path.join(repo, "scripts");
  await fs.mkdir(scriptsDir, { recursive: true });
  const scriptPath = path.join(scriptsDir, "acp-mc-resolve-cwd.sh");
  const redirected = params.redirectedCwd ?? "/private/tmp/mc-acp/test-label";
  const payload = JSON.stringify(
    {
      schema: "mc.acp-mc-resolve-cwd.v1",
      redirected: true,
      reason: "default_checkout_redirect",
      requestedCwd: params.defaultCheckout,
      cwd: redirected,
      bindingKey: params.bindingKey ?? "label:test",
      registryPath: `${repo}/.cache/mc-acp-worktrees/label-test.json`,
      branch: "codex/acp-label-test",
      headShort: "deadbeef",
      created: true,
    },
    null,
    2,
  );
  await fs.writeFile(
    scriptPath,
    `#!/usr/bin/env bash
cat <<'JSON'
${payload}
JSON
`,
  );
  await fs.chmod(scriptPath, 0o755);
  return repo;
}

describe("resolveMcAcpSpawnCwd", () => {
  it("passes through non-default cwd unchanged", async () => {
    const result = await resolveMcAcpSpawnCwd({
      requestedCwd: "/home/bob/clawd",
      mcRepo: "/tmp/unused",
    });
    expect(result).toEqual({
      redirected: false,
      cwd: "/home/bob/clawd",
      requestedCwd: "/home/bob/clawd",
    });
  });

  it("redirects MC default checkout through the resolve script", async () => {
    const mcRepo = await makeMcRepo({
      defaultCheckout: "",
      redirectedCwd: "/private/tmp/mc-acp/label-mc-claude",
      bindingKey: "label:mc-claude",
    });
    const result = await resolveMcAcpSpawnCwd({
      requestedCwd: mcRepo,
      label: "mc-claude",
      conversationId: "chat-123",
      threadId: "topic-456",
      mcRepo,
    });
    expect(result.redirected).toBe(true);
    expect(result.cwd).toBe("/private/tmp/mc-acp/label-mc-claude");
    expect(result.bindingKey).toBe("label:mc-claude");
  });

  it("degrades gracefully when the resolve script is missing", async () => {
    const mcRepo = await fs.mkdtemp(path.join(os.tmpdir(), "mc-repo-empty-"));
    tempDirs.push(mcRepo);
    const result = await resolveMcAcpSpawnCwd({
      requestedCwd: mcRepo,
      mcRepo,
    });
    expect(result.redirected).toBe(false);
    expect(result.cwd).toBe(mcRepo);
    expect(result.reason).toBe("script_missing");
  });
});
