import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand } from "../../src/core/application/command-router.js";
import { IdentityService } from "../../src/core/application/identity-service.js";
import { formatRelativeTime, summarizeText } from "../../src/core/application/mobile-text.js";
import { renderRecap } from "../../src/core/application/recap.js";
import { DomainError } from "../../src/core/domain/errors.js";
import { openSession } from "../fakes/core-fakes.js";

test("single-owner allowlist rejects unknown senders", () => {
  const identities = new IdentityService([
    { accountId: "wechat-1", senderId: "owner", gatewayUserId: "local-owner" }
  ]);
  assert.equal(identities.authorize("wechat-1", "owner").gatewayUserId, "local-owner");
  assert.throws(
    () => identities.authorize("wechat-1", "stranger"),
    (error) => error instanceof DomainError && error.code === "identity_unauthorized"
  );
});

test("command parser never treats unknown slash commands as ordinary input", () => {
  assert.deepEqual(parseCommand("please inspect tests"), { kind: "input", text: "please inspect tests" });
  assert.deepEqual(parseCommand("/new codex agentlink"), {
    kind: "new", agent: "codex", project: "agentlink"
  });
  assert.deepEqual(parseCommand("/new 2"), {
    kind: "new", project: "2"
  });
  assert.deepEqual(parseCommand("/help"), { kind: "help" });
  assert.deepEqual(parseCommand("/use 1"), { kind: "use", sessionId: "1" });
  assert.deepEqual(parseCommand("/delete 1"), { kind: "delete", sessionId: "1" });
  assert.deepEqual(parseCommand("/delete confirm abc123"), {
    kind: "delete_confirm", sessionId: "abc123"
  });
  assert.deepEqual(parseCommand("/delete confirm"), {
    kind: "delete_confirm"
  });
  assert.deepEqual(parseCommand("/queue cancel"), { kind: "queue_cancel" });
  assert.deepEqual(parseCommand("/queue cancel turn-9"), { kind: "queue_cancel", turnId: "turn-9" });
  assert.deepEqual(parseCommand("/approve A7F3"), {
    kind: "approval", decision: "allow_once", leaseId: "A7F3"
  });
  assert.deepEqual(parseCommand("/approve"), {
    kind: "approval", decision: "allow_once"
  });
  assert.throws(
    () => parseCommand("/help commands"),
    (error) => error instanceof DomainError && error.code === "command_argument_invalid"
  );
  assert.throws(
    () => parseCommand("/approve A7F3 extra"),
    (error) => error instanceof DomainError && error.code === "command_argument_invalid"
  );
  assert.throws(
    () => parseCommand("/shell rm -rf something"),
    (error) => error instanceof DomainError && error.code === "command_unknown"
  );
});

test("mobile summaries keep twenty graphemes and Session activity uses relative time", () => {
  assert.equal(
    summarizeText("12345678901234567890X"),
    "12345678901234567890…"
  );
  assert.equal(summarizeText("👨‍👩‍👧‍👦甲乙", 2), "👨‍👩‍👧‍👦甲…");
  assert.equal(
    formatRelativeTime("2026-07-19T00:00:00.000Z", "2026-07-19T02:15:00.000Z"),
    "2h ago"
  );
});

test("recap is mechanical and exposes the last verified final response", () => {
  const session = openSession();
  const recap = renderRecap(session, [{
    id: "turn-1", sessionId: session.id, state: "COMPLETED", inputSequence: 1,
    sourceEndpointId: "local", text: "work", finalResponse: "tests passed",
    createdAt: session.createdAt, updatedAt: session.updatedAt
  }]);
  assert.match(recap, /上次结果：tests passed/u);
});
