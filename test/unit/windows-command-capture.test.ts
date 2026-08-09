import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  captureCommandOutput,
  spawnWindowsAgent
} from "../../src/platform-windows/process-control.js";
import { readCodexVersion } from "../../src/agent-codex/protocol/version-gate.js";

test("Windows .cmd agent version probe is captured through the controlled launcher", async (t) => {
  if (process.platform !== "win32") t.skip("Windows-only");
  const directory = await mkdtemp(join(tmpdir(), "agentlink-cmd-probe-"));
  const cmd = join(directory, "fixture-agent.cmd");
  try {
    await writeFile(cmd, "@echo off\r\nnode --version\r\n", "utf8");
    const output = await captureCommandOutput(cmd, ["--version"], {
      timeoutMs: 5_000
    });
    assert.match(output, /v22/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex version gate accepts a .cmd command on Windows", async (t) => {
  if (process.platform !== "win32") t.skip("Windows-only");
  const directory = await mkdtemp(join(tmpdir(), "agentlink-codex-cmd-"));
  const cmd = join(directory, "codex-fixture.cmd");
  try {
    await writeFile(cmd, "@echo off\r\necho codex-cli 0.146.0\r\n", "utf8");
    const version = await readCodexVersion(cmd);
    assert.equal(version.raw, "0.146.0");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows .cmd agent arguments reject shell metacharacters", async (t) => {
  if (process.platform !== "win32") t.skip("Windows-only");
  const directory = await mkdtemp(join(tmpdir(), "agentlink-cmd-args-"));
  const cmd = join(directory, "fixture-agent.cmd");
  try {
    await writeFile(cmd, "@echo off\r\necho %*\r\n", "utf8");
    for (const value of ["a&b", "a|b", "a<b", "a>b", "a^b", "a%b", "a!b", "a\"b", "a\rb"]) {
      assert.throws(
        () => spawnWindowsAgent(cmd, [value], {}),
        /unsupported shell characters/u,
        value
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
