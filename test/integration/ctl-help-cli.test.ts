import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { join } from "node:path";

const execFile = promisify(execFileCallback);
const ctl = join(process.cwd(), "dist", "src", "ctl.js");

for (const argument of ["--help", "-h", "help"]) {
  test(`agentlink ${argument} prints help and exits successfully`, async () => {
    const result = await execFile(process.execPath, [ctl, argument]);
    assert.match(result.stdout, /AgentLink 本机控制命令/u);
    assert.match(result.stdout, /agentlink doctor/u);
    assert.equal(result.stderr, "");
  });
}

test("project add help documents exact arguments and succeeds", async () => {
  const result = await execFile(process.execPath, [ctl, "project", "add", "--help"]);
  assert.match(result.stdout, /--slug <名称>/u);
  assert.match(result.stdout, /--agent <codex,grok>/u);
  assert.equal(result.stderr, "");
});

test("session list help documents human and JSON output options", async () => {
  const result = await execFile(process.execPath, [ctl, "session", "list", "--help"]);
  assert.match(result.stdout, /--json/u);
  assert.equal(result.stderr, "");
});
