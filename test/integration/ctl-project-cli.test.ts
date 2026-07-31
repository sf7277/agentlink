import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  ensureMacosApplicationPaths,
  macosApplicationPaths
} from "../../src/platform-macos/application-paths.js";
import { AtomicConfigStore } from "../../src/platform-macos/atomic-config-store.js";

const execFileAsync = promisify(execFile);

test("agentlink Project Registry CRUD works without source scripts and preserves directories", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-ctl-home-"));
  const first = join(home, "first");
  const second = join(home, "second");
  await mkdir(first);
  await mkdir(second);
  const paths = macosApplicationPaths(home);
  await ensureMacosApplicationPaths(paths);
  await new AtomicConfigStore(paths.config).save({
    codex: {
      command: "codex",
      maxActiveTurns: 4,
      requestPermissionsTool: true,
      experimentalApi: false
    }
  });
  const ctl = join(process.cwd(), "dist", "src", "ctl.js");
  const run = (...args: string[]) => execFileAsync(process.execPath, [ctl, ...args], {
    env: { ...process.env, HOME: home },
    maxBuffer: 64 * 1024
  });

  const added = JSON.parse((await run(
    "project", "add", "--slug", "demo", "--path", first, "--agent", "codex", "--json"
  )).stdout) as Record<string, unknown>;
  assert.equal(added["status"], "added");
  const humanList = (await run("project", "list")).stdout;
  assert.match(humanList, /项目\s+默认Agent\s+状态/u);
  assert.match(humanList, /demo/u);
  const listed = JSON.parse((await run("project", "list", "--json")).stdout) as {
    slug: string;
    path: string;
  }[];
  assert.deepEqual(listed.map((item) => item.slug), ["demo"]);
  assert.equal(listed[0]?.path, await realpath(first));

  const updated = JSON.parse((await run(
    "project", "update", "--slug", "demo", "--path", second, "--agent", "codex", "--json"
  )).stdout) as Record<string, unknown>;
  assert.equal(updated["status"], "updated");
  const removed = JSON.parse((await run(
    "project", "remove", "--slug", "demo", "--json"
  )).stdout) as Record<string, unknown>;
  assert.equal(removed["directory"], "preserved");
  assert.deepEqual(JSON.parse((await run("project", "list", "--json")).stdout), []);
  await assert.rejects(mkdir(second), (error: NodeJS.ErrnoException) => error.code === "EEXIST");
});
