import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { ControlRepository } from "../../src/storage-sqlite/control-repository.js";
import { SqliteStateStore } from "../../src/storage-sqlite/sqlite-state-store.js";
import { openSession } from "../fakes/core-fakes.js";

test("conversation binding and approval audit persist only control facts", () => {
  const store = new SqliteStateStore(":memory:", join(process.cwd(), "migrations"));
  const now = "2026-07-18T00:00:00.000Z";
  store.database.prepare(`
    INSERT INTO channel_accounts(id, channel_kind, created_at) VALUES ('account-1', 'fake', ?)
  `).run(now);
  store.database.prepare(`
    INSERT INTO projects(id, slug, canonical_path, allowed_agents_json, created_at)
    VALUES ('project-1', 'project', '/tmp/project', '["fake"]', ?)
  `).run(now);
  store.transaction((transaction) => {
    transaction.putSession(openSession());
    transaction.putTurn({
      id: "turn-1", sessionId: "session-1", state: "RUNNING", inputSequence: 1,
      sourceEndpointId: "owner", text: "work", createdAt: now, updatedAt: now
    });
  });
  const repository = new ControlRepository(store.database);
  repository.saveCursor("account-1", "cursor-1", now);
  repository.saveCursor("account-1", "cursor-1", "2026-07-18T01:00:00.000Z");
  assert.deepEqual(store.database.prepare(`
    SELECT cursor, updated_at FROM channel_cursors WHERE account_id = 'account-1'
  `).get(), { cursor: "cursor-1", updated_at: now });
  repository.setCredentialStatus("account-1", "AUTHENTICATION_REQUIRED", now);
  assert.equal(repository.credentialStatus("account-1"), "AUTHENTICATION_REQUIRED");
  repository.bindConversation("conversation-1", "account-1", "platform-conversation", "session-1", now);
  assert.equal(repository.activeSessionFor("conversation-1"), "session-1");
  repository.appendApprovalAudit({
    id: "audit-1",
    sessionId: "session-1",
    turnId: "turn-1",
    actionDigest: "digest-placeholder",
    decision: "deny",
    observedState: "resolved",
    createdAt: now
  });
  const audit = store.database.prepare(`
    SELECT action_digest, decision FROM approval_audit WHERE id = 'audit-1'
  `).get() as { action_digest: string; decision: string };
  assert.deepEqual(audit, { action_digest: "digest-placeholder", decision: "deny" });
  store.close();
});
