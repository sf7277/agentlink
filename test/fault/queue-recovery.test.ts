import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionLinearizer } from "../../src/core/application/session-linearizer.js";
import { TurnQueue } from "../../src/core/application/turn-queue.js";
import { DomainError } from "../../src/core/domain/errors.js";
import {
  FakeAgent,
  FakeClock,
  FakeIdGenerator,
  MemoryStateStore,
  openSession
} from "../fakes/core-fakes.js";

function addCompletedTurn(store: MemoryStateStore, sessionId: string): void {
  store.turns.set(`turn-${sessionId}`, {
    id: `turn-${sessionId}`,
    sessionId,
    state: "COMPLETED",
    inputSequence: 1,
    queueSequence: 1,
    sourceEndpointId: "wechat-owner",
    text: "historical turn",
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z"
  });
}

test("failed/cancelled active Turn pauses FIFO until explicit resume", async () => {
  const store = new MemoryStateStore();
  store.sessions.set("session-1", openSession());
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  const queue = new TurnQueue(
    store, agent, new FakeClock(), new FakeIdGenerator(), new SessionLinearizer()
  );
  const active = await queue.enqueue("session-1", "wechat-owner", "first");
  await queue.enqueue("session-1", "local-cli", "second");
  await queue.fail(active.id, "FAILED");
  assert.deepEqual(
    [...store.turns.values()].sort((a, b) => a.inputSequence - b.inputSequence).map((item) => item.state),
    ["FAILED", "PAUSED"]
  );
  await queue.resumeQueue("session-1");
  assert.equal(agent.sent.length, 2);
});

test("stop is scoped to the active Turn and repeated stop is already_resolved", async () => {
  const store = new MemoryStateStore();
  store.sessions.set("session-1", openSession());
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  const queue = new TurnQueue(
    store, agent, new FakeClock(), new FakeIdGenerator(), new SessionLinearizer()
  );
  const active = await queue.enqueue("session-1", "wechat-owner", "first");
  const queued = await queue.enqueue("session-1", "local-cli", "second");
  assert.equal(await queue.stop("session-1"), "cancelled_paused");
  assert.deepEqual(agent.cancelled, [{ sessionId: "session-1", turnId: active.id }]);
  assert.equal(store.turns.get(queued.id)?.state, "PAUSED");
  assert.equal(await queue.stop("session-1"), "already_resolved");
  const later = await queue.enqueue("session-1", "wechat-owner", "later");
  assert.equal(later.state, "PAUSED");
});

test("close resolves Session and cancels queued work without assuming Runtime ownership", async () => {
  const store = new MemoryStateStore();
  store.sessions.set("session-1", openSession());
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  const queue = new TurnQueue(
    store, agent, new FakeClock(), new FakeIdGenerator(), new SessionLinearizer()
  );
  await queue.enqueue("session-1", "wechat-owner", "first");
  const queued = await queue.enqueue("session-1", "local-cli", "second");
  assert.equal(await queue.close("session-1"), "closed");
  assert.equal(store.sessions.get("session-1")?.state, "CLOSED");
  assert.equal(store.turns.get(queued.id)?.state, "CANCELLED");
  assert.deepEqual(agent.closed, ["session-1"]);
});

test("close works for a post-restart UNKNOWN Session and close uncertainty is explicit", async () => {
  const store = new MemoryStateStore();
  store.sessions.set("session-1", {
    ...openSession(),
    nativeSessionId: "thread-1",
    state: "UNKNOWN",
    runtimeState: "UNKNOWN",
    queuePaused: true
  });
  addCompletedTurn(store, "session-1");
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  const queue = new TurnQueue(
    store, agent, new FakeClock(), new FakeIdGenerator(), new SessionLinearizer()
  );
  assert.equal(await queue.close("session-1"), "closed");
  assert.equal(store.sessions.get("session-1")?.state, "CLOSED");

  store.sessions.set("session-2", {
    ...openSession("session-2"),
    nativeSessionId: "thread-2"
  });
  addCompletedTurn(store, "session-2");
  agent.close = async () => { throw new Error("archive uncertain"); };
  await assert.rejects(queue.close("session-2"), /archive uncertain/u);
  assert.equal(store.sessions.get("session-2")?.state, "UNKNOWN");
  assert.equal(store.sessions.get("session-2")?.runtimeState, "UNKNOWN");
});

test("definite native close rejection restores the original OPEN Session", async () => {
  const store = new MemoryStateStore();
  store.sessions.set("session-1", {
    ...openSession(),
    nativeSessionId: "native-session-1"
  });
  addCompletedTurn(store, "session-1");
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  agent.close = async () => {
    throw new DomainError("native_close_unsupported", "Session close is unsupported");
  };
  const queue = new TurnQueue(
    store, agent, new FakeClock(), new FakeIdGenerator(), new SessionLinearizer()
  );

  await assert.rejects(
    queue.close("session-1"),
    (error) => error instanceof DomainError && error.code === "native_close_unsupported"
  );
  assert.equal(store.sessions.get("session-1")?.state, "OPEN");
  assert.equal(store.sessions.get("session-1")?.runtimeState, "ALIVE");
});
