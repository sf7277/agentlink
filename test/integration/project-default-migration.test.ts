import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import {
  ensureMacosApplicationPaths,
  macosApplicationPaths
} from "../../src/platform-macos/application-paths.js";
import { AtomicConfigStore } from "../../src/platform-macos/atomic-config-store.js";
import { migrateProjectDefaults } from "../../src/platform-macos/project-default-migration.js";
import { SqliteStateStore } from "../../src/storage-sqlite/sqlite-state-store.js";

test("one-time Project migration derives defaults in config and SQLite", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-project-default-migration-"));
  const paths = macosApplicationPaths(home);
  await ensureMacosApplicationPaths(paths);
  await writeFile(paths.config, `${JSON.stringify({
    codex: {
      command: "codex",
      maxActiveTurns: 4,
      requestPermissionsTool: true,
      experimentalApi: false
    },
    grok: { command: "grok" },
    projects: [
      {
        id: "project-grok",
        slug: "grok-only",
        path: "/tmp/grok-only",
        allowedAgents: ["grok"],
        enabled: true
      },
      {
        id: "project-mixed",
        slug: "mixed",
        path: "/tmp/mixed",
        allowedAgents: ["grok", "codex"],
        enabled: true
      }
    ]
  }, null, 2)}\n`, { mode: 0o600 });
  const legacyMigrations = join(home, "legacy-migrations");
  await mkdir(legacyMigrations);
  for (const filename of [
    "001_initial.sql",
    "002_product_lifecycle.sql",
    "003_bounded_import_provenance.sql"
  ]) {
    await copyFile(join(process.cwd(), "migrations", filename), join(legacyMigrations, filename));
  }
  new SqliteStateStore(paths.database, legacyMigrations).close();
  await chmod(paths.database, 0o600);
  const database = new Database(paths.database);
  database.prepare(`
    INSERT INTO projects(id, slug, canonical_path, allowed_agents_json, enabled, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run("project-grok", "grok-only", "/tmp/grok-only", '["grok"]', "2026-07-25T00:00:00Z");
  database.prepare(`
    INSERT INTO projects(id, slug, canonical_path, allowed_agents_json, enabled, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(
    "project-mixed",
    "mixed",
    "/tmp/mixed",
    '["grok","codex"]',
    "2026-07-25T00:00:00Z"
  );
  database.close();

  const first = await migrateProjectDefaults({
    configPath: paths.config,
    databasePath: paths.database,
    migrationsDirectory: join(process.cwd(), "migrations")
  });
  assert.deepEqual(first, { configChanged: true, databaseChanged: true });
  const config = await new AtomicConfigStore(paths.config).load();
  assert.equal(config.projects[0]?.defaultAgent, "grok");
  assert.equal(config.projects[1]?.defaultAgent, "codex");
  const migrated = new Database(paths.database, { readonly: true });
  assert.deepEqual(
    migrated.prepare("SELECT slug, default_agent FROM projects ORDER BY slug").all(),
    [
      { slug: "grok-only", default_agent: "grok" },
      { slug: "mixed", default_agent: "codex" }
    ]
  );
  migrated.close();

  assert.deepEqual(await migrateProjectDefaults({
    configPath: paths.config,
    databasePath: paths.database,
    migrationsDirectory: join(process.cwd(), "migrations")
  }), { configChanged: false, databaseChanged: false });
});

test("ambiguous legacy Project stops before changing config or SQLite", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-project-default-reject-"));
  const paths = macosApplicationPaths(home);
  await ensureMacosApplicationPaths(paths);
  const original = `${JSON.stringify({
    grok: { command: "grok" },
    projects: [{
      id: "project-ambiguous",
      slug: "ambiguous",
      path: "/tmp/ambiguous",
      allowedAgents: ["grok", "future-agent"],
      enabled: true
    }]
  }, null, 2)}\n`;
  await writeFile(paths.config, original, { mode: 0o600 });
  await assert.rejects(migrateProjectDefaults({
    configPath: paths.config,
    databasePath: paths.database,
    migrationsDirectory: join(process.cwd(), "migrations")
  }), /choose --default-agent before upgrade/u);
  assert.equal(await readFile(paths.config, "utf8"), original);
});
