import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteStateStore } from "../../src/storage-sqlite/sqlite-state-store.js";
import { renderRecap } from "../../src/core/application/recap.js";
import type { Turn } from "../../src/core/domain/model.js";
import { openSession } from "../fakes/core-fakes.js";

const migrationDirectory = join(process.cwd(), "migrations");
const now = "2026-07-18T00:00:00.000Z";

function prepare(store: SqliteStateStore): void {
  store.database.prepare(`
    INSERT INTO channel_accounts(id, channel_kind, created_at) VALUES ('account-1', 'fake', ?)
  `).run(now);
  store.database.prepare(`
    INSERT INTO projects(id, slug, canonical_path, allowed_agents_json, created_at)
    VALUES ('project-1', 'project', '/tmp/project', '["fake"]', ?)
  `).run(now);
  store.transaction((transaction) => transaction.putSession(openSession()));
}

function turn(id: string, inputSequence: number): Turn {
  return {
    id, sessionId: "session-1", state: "QUEUED", inputSequence,
    queueSequence: inputSequence, sourceEndpointId: "wechat-owner", text: id,
    createdAt: now, updatedAt: now
  };
}

test("migration is repeatable and modified applied migration is rejected", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentlink-migration-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const localMigrations = join(root, "migrations");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(localMigrations);
  const source = await readFile(join(migrationDirectory, "001_initial.sql"), "utf8");
  await writeFile(join(localMigrations, "001_initial.sql"), source);
  const database = join(root, "state.sqlite");
  new SqliteStateStore(database, localMigrations).close();
  new SqliteStateStore(database, localMigrations).close();
  await writeFile(join(localMigrations, "001_initial.sql"), `${source}\n-- changed\n`);
  assert.throws(() => new SqliteStateStore(database, localMigrations), /has changed/u);
});

test("duplicate platform message does not create a second Turn", () => {
  const store = new SqliteStateStore(":memory:", migrationDirectory);
  prepare(store);
  assert.equal(store.acceptMessageAndTurn("account-1", "message-1", now, turn("turn-1", 1)), true);
  assert.equal(store.acceptMessageAndTurn("account-1", "message-1", now, turn("turn-2", 2)), false);
  const count = store.database.prepare("SELECT COUNT(*) AS count FROM turns").get() as { count: number };
  assert.equal(count.count, 1);
  store.close();
});

test("bounded import provenance survives SQLite round-trip", () => {
  const store = new SqliteStateStore(":memory:", migrationDirectory);
  prepare(store);
  store.transaction((transaction) => transaction.putSession({
    ...openSession(),
    nativeSessionId: "thread-continuation",
    sourceNativeSessionId: "thread-source",
    nativeLifecycleOwner: "AGENTLINK",
    historyTruncated: true
  }));
  const loaded = store.transaction((transaction) => transaction.getSession("session-1"));
  assert.equal(loaded?.nativeSessionId, "thread-continuation");
  assert.equal(loaded?.sourceNativeSessionId, "thread-source");
  assert.equal(loaded?.historyTruncated, true);
  store.close();
});

test("receipt batch and cursor advance atomically", () => {
  const store = new SqliteStateStore(":memory:", migrationDirectory);
  prepare(store);
  assert.throws(() => store.acceptBatchAndCursor("account-1", "cursor-2", now, [
    { messageId: "message-1", turn: turn("turn-1", 1) },
    { messageId: "message-2", turn: turn("turn-2", 1) }
  ]), /UNIQUE constraint failed/u);
  const receipts = store.database.prepare("SELECT COUNT(*) AS count FROM message_receipts").get() as
    { count: number };
  const cursor = store.database.prepare("SELECT cursor FROM channel_cursors").get();
  assert.equal(receipts.count, 0);
  assert.equal(cursor, undefined);
  store.close();
});

test("startup reconciliation never restores runtime or pending work as active", () => {
  const store = new SqliteStateStore(":memory:", migrationDirectory);
  prepare(store);
  store.transaction((transaction) => {
    transaction.putTurn({
      ...turn("turn-1", 1),
      state: "WAITING_AGENT_APPROVAL"
    });
    transaction.putTurn(turn("turn-2", 2));
  });
  store.reconcileStartup("2026-07-18T01:00:00.000Z");
  const session = store.transaction((transaction) => transaction.getSession("session-1"));
  const turns = store.transaction((transaction) => transaction.listTurns("session-1"));
  assert.equal(session?.state, "UNKNOWN");
  assert.equal(session?.runtimeState, "UNKNOWN");
  assert.equal(session?.queuePaused, true);
  assert.deepEqual(turns.map((item) => item.state), ["UNKNOWN", "PAUSED"]);
  assert.match(renderRecap(session ?? openSession(), turns), /（session-1）· UNKNOWN/u);
  store.close();
});
