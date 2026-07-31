import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ensureMacosApplicationPaths,
  macosApplicationPaths
} from "../../src/platform-macos/application-paths.js";
import { ProjectConfigService } from "../../src/platform-macos/project-config-service.js";
import { AtomicConfigStore } from "../../src/platform-macos/atomic-config-store.js";

async function configureCodex(configPath: string): Promise<void> {
  await new AtomicConfigStore(configPath).save({
    codex: {
      command: "codex",
      maxActiveTurns: 4,
      requestPermissionsTool: true,
      experimentalApi: false
    }
  });
}

test("Project config CRUD is atomic, canonical and never deletes project directories", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-project-cli-"));
  const paths = macosApplicationPaths(home);
  await ensureMacosApplicationPaths(paths);
  const first = join(home, "project-a");
  const second = join(home, "project-b");
  await mkdir(first);
  await mkdir(second);
  await configureCodex(paths.config);
  const service = new ProjectConfigService(paths.config);

  const added = await service.add({
    slug: "project-a",
    path: first,
    allowedAgents: ["codex", "codex"]
  });
  assert.equal(added.slug, "project-a");
  assert.deepEqual(added.allowedAgents, ["codex"]);
  assert.deepEqual((await service.list()).map((project) => project.slug), ["project-a"]);

  assert.equal((await service.disable("project-a")).enabled, false);
  assert.equal((await service.list())[0]?.enabled, false);
  assert.equal((await service.enable("project-a")).enabled, true);

  const updated = await service.update({
    slug: "project-a",
    path: second,
    allowedAgents: ["codex"]
  });
  assert.equal(updated.id, added.id);
  assert.equal(updated.path, await realpath(second));
  await service.remove("project-a");
  assert.deepEqual(await service.list(), []);
  assert.equal(await mkdir(second, { recursive: false }).then(
    () => false,
    (error: NodeJS.ErrnoException) => error.code === "EEXIST"
  ), true);
});

test("Project config rejects duplicate paths and symlink roots", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-project-boundary-"));
  const paths = macosApplicationPaths(home);
  await ensureMacosApplicationPaths(paths);
  const project = join(home, "project");
  const linked = join(home, "linked");
  await mkdir(project);
  await symlink(project, linked);
  await configureCodex(paths.config);
  const service = new ProjectConfigService(paths.config);
  await service.add({ slug: "project", path: project, allowedAgents: ["codex"] });
  await assert.rejects(
    service.add({ slug: "duplicate", path: project, allowedAgents: ["codex"] }),
    /already registered/u
  );
  await assert.rejects(
    service.add({ slug: "linked", path: linked, allowedAgents: ["codex"] }),
    /symbolic link/u
  );
});
