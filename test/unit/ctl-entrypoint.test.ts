import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AGENTLINK_VERSION } from "../../src/version.js";

test("control CLI runs through an npm-style symlink", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlink-ctl-entrypoint-"));
  const link = join(directory, "agentlink");
  const ctlPath = fileURLToPath(new URL("../../src/ctl.js", import.meta.url));
  try {
    await symlink(ctlPath, link);
    const result = await new Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [link, "--version"], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), AGENTLINK_VERSION);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
