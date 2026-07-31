import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import {
  ensureMacosApplicationPaths,
  macosApplicationPaths
} from "../../src/platform-macos/application-paths.js";
import {
  AtomicConfigStore,
  ReloadableConfig
} from "../../src/platform-macos/atomic-config-store.js";
import { SqliteBackupManager } from "../../src/storage-sqlite/backup-manager.js";

test("macOS paths and config are private, atomic and retain the last valid reload", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-delivery-home-"));
  const paths = macosApplicationPaths(home);
  await ensureMacosApplicationPaths(paths);
  for (const path of [
    paths.applicationSupport,
    paths.caches,
    paths.logs,
    paths.runtime,
    paths.releases,
    paths.backups
  ]) {
    assert.equal((await lstat(path)).mode & 0o777, 0o700);
  }

  const store = new AtomicConfigStore(paths.config);
  const initial = {
    queueLimit: 32,
    maxInputBytes: 64 * 1024,
    maxOutputBytes: 256 * 1024,
    requestsPerMinute: 120,
    approvalLeaseMs: 5 * 60_000,
    codex: {
      command: "codex",
      maxActiveTurns: 4,
      requestPermissionsTool: true,
      experimentalApi: false
    },
    projects: [{
      id: "project-1",
      slug: "agentlink",
      path: "/private/project",
      allowedAgents: ["codex"],
      defaultAgent: "codex",
      enabled: true
    }]
  };
  await store.save(initial);
  assert.equal((await lstat(paths.config)).mode & 0o777, 0o600);
  const reloadable = new ReloadableConfig(store);
  assert.deepEqual(await reloadable.initialize(), initial);
  await writeFile(paths.config, "{\"queueLimit\":0}", { mode: 0o600 });
  const rejected = await reloadable.reload();
  assert.equal(rejected.ok, false);
  assert.deepEqual(rejected.config, initial);

  const target = join(paths.applicationSupport, "config-target.json");
  await writeFile(target, "{}", { mode: 0o600 });
  const linked = join(paths.applicationSupport, "linked-config.json");
  await symlink(target, linked);
  await assert.rejects(new AtomicConfigStore(linked).load(), /trusted private regular file/u);
});

test("SQLite online backup and restore preserve a valid database without copying WAL files", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-db-backup-home-"));
  const paths = macosApplicationPaths(home);
  await ensureMacosApplicationPaths(paths);
  const source = new Database(paths.database);
  source.pragma("journal_mode = WAL");
  source.exec("CREATE TABLE facts(id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  source.prepare("INSERT INTO facts(value) VALUES (?)").run("before");
  source.close();
  await chmod(paths.database, 0o600);

  const backup = join(paths.backups, "snapshot.sqlite");
  const manager = new SqliteBackupManager();
  await manager.backup(paths.database, backup);
  assert.equal((await lstat(backup)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(paths.backups), ["snapshot.sqlite"]);

  const changed = new Database(paths.database);
  changed.prepare("INSERT INTO facts(value) VALUES (?)").run("after");
  changed.close();
  await manager.restore(backup, paths.database);
  const restored = new Database(paths.database, { readonly: true });
  assert.deepEqual(
    restored.prepare("SELECT value FROM facts ORDER BY id").all(),
    [{ value: "before" }]
  );
  restored.close();

  await writeFile(backup, "not a database", { mode: 0o600 });
  await assert.rejects(manager.restore(backup, paths.database));
  assert.match(await readFile(paths.database).then((value) => value.subarray(0, 15).toString()), /SQLite format 3/u);
});
