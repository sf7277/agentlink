import assert from "node:assert/strict";
import { test } from "node:test";
import { TurnQueue } from "../../src/core/application/turn-queue.js";
import { SessionLinearizer } from "../../src/core/application/session-linearizer.js";
import { DomainError } from "../../src/core/domain/errors.js";
import type { AgentPort } from "../../src/core/contracts/ports.js";
import {
  FakeAgent,
  FakeClock,
  FakeIdGenerator,
  MemoryStateStore,
  openSession
} from "../fakes/core-fakes.js";

function setup(steering = true) {
  const store = new MemoryStateStore();
  store.sessions.set("session-1", openSession());
  const agent = new FakeAgent({ steering, cancellation: true, approvals: true });
  const queue = new TurnQueue(
    store, agent, new FakeClock(), new FakeIdGenerator(), new SessionLinearizer(), 2
  );
  return { store, agent, queue };
}

test("concurrent inputs receive one order and only one Turn is active", async () => {
  const { store, agent, queue } = setup();
  await Promise.all([
    queue.enqueue("session-1", "wechat-owner", "first"),
    queue.enqueue("session-1", "local-cli", "second")
  ]);
  const turns = [...store.turns.values()].sort((a, b) => a.inputSequence - b.inputSequence);
  assert.deepEqual(turns.map((turn) => turn.inputSequence), [1, 2]);
  assert.deepEqual(turns.map((turn) => turn.sourceEndpointId), ["wechat-owner", "local-cli"]);
  assert.deepEqual(turns.map((turn) => turn.state), ["RUNNING", "QUEUED"]);
  assert.equal(agent.sent.length, 1);
  await queue.complete(turns[0]?.id ?? "", "done");
  assert.equal(agent.sent.length, 2);
  assert.equal(store.turns.get(turns[1]?.id ?? "")?.state, "RUNNING");
});

test("uncertain external send marks active UNKNOWN and pauses following queue", async () => {
  const { store, agent, queue } = setup();
  agent.failNextSend = true;
  await queue.enqueue("session-1", "wechat-owner", "first");
  await queue.enqueue("session-1", "local-cli", "second");
  const turns = [...store.turns.values()].sort((a, b) => a.inputSequence - b.inputSequence);
  assert.deepEqual(turns.map((turn) => turn.state), ["UNKNOWN", "PAUSED"]);
  assert.equal(agent.sent.length, 1);
});

test("queue resume stays paused while a Turn is still UNKNOWN", async () => {
  const { store, queue } = setup();
  const session = store.sessions.get("session-1")!;
  store.sessions.set("session-1", { ...session, queuePaused: true });
  store.turns.set("turn-unknown", {
    id: "turn-unknown",
    sessionId: "session-1",
    state: "UNKNOWN",
    inputSequence: 1,
    sourceEndpointId: "wechat-owner",
    text: "uncertain",
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z"
  });

  await assert.rejects(
    queue.resumeQueue("session-1"),
    (error) => error instanceof DomainError && error.code === "turn_status_unknown"
  );
  assert.equal(store.sessions.get("session-1")?.queuePaused, true);
});

test("recovered queue is unlocked only when it has no unfinished work", async () => {
  const empty = setup();
  const emptySession = empty.store.sessions.get("session-1")!;
  empty.store.sessions.set("session-1", { ...emptySession, queuePaused: true });
  assert.deepEqual(await empty.queue.prepareRecoveredSession("session-1"), { kind: "ready" });
  assert.equal(empty.store.sessions.get("session-1")?.queuePaused, false);

  const paused = setup();
  const pausedSession = paused.store.sessions.get("session-1")!;
  paused.store.sessions.set("session-1", { ...pausedSession, queuePaused: true });
  const pausedTurn = await paused.queue.enqueue("session-1", "wechat-owner", "old work");
  const pausedDisposition = await paused.queue.prepareRecoveredSession("session-1");
  assert.deepEqual(pausedDisposition, { kind: "paused", count: 1 });
  assert.equal(paused.store.turns.get(pausedTurn.id)?.state, "PAUSED");
  assert.equal(paused.store.sessions.get("session-1")?.queuePaused, true);

  const active = setup();
  const activeTurn = await active.queue.enqueue("session-1", "wechat-owner", "running work");
  const activeDisposition = await active.queue.prepareRecoveredSession("session-1");
  assert.equal(activeDisposition.kind, "active");
  assert.equal(activeDisposition.kind === "active" ? activeDisposition.turn.id : "", activeTurn.id);
});

test("approval lifecycle records waiting and returns to running", async () => {
  const { store, queue } = setup();
  const turn = await queue.enqueue("session-1", "wechat-owner", "approval");
  await queue.waitForApproval(turn.id);
  assert.equal(store.turns.get(turn.id)?.state, "WAITING_AGENT_APPROVAL");
  await queue.approvalResolved(turn.id);
  assert.equal(store.turns.get(turn.id)?.state, "RUNNING");
});

test("steer is capability-gated", async () => {
  const { queue } = setup(false);
  await queue.enqueue("session-1", "wechat-owner", "first");
  await assert.rejects(
    queue.steer("session-1", "local-cli", "constraint"),
    (error) => error instanceof DomainError && error.code === "steer_unsupported"
  );
});

test("queued cancellation is compare-and-set and repeat returns already_resolved", async () => {
  const { queue } = setup();
  await queue.enqueue("session-1", "wechat-owner", "first");
  const queued = await queue.enqueue("session-1", "local-cli", "second");
  assert.equal(await queue.cancelQueued("session-1", queued.id), "cancelled");
  assert.equal(await queue.cancelQueued("session-1", queued.id), "already_resolved");
});

test("single paused cancellation clears an otherwise empty queue pause", async () => {
  const { store, queue } = setup();
  const session = store.sessions.get("session-1")!;
  store.sessions.set("session-1", { ...session, queuePaused: true });
  const paused = await queue.enqueue("session-1", "wechat-owner", "paused work");
  assert.equal(paused.state, "PAUSED");
  assert.equal((await queue.cancelOnlyQueued("session-1"))?.id, paused.id);
  assert.equal(store.turns.get(paused.id)?.state, "CANCELLED");
  assert.equal(store.sessions.get("session-1")?.queuePaused, false);
  assert.equal(await queue.cancelOnlyQueued("session-1"), undefined);
});

test("single-item cancellation refuses to guess when several items are queued", async () => {
  const { store, queue } = setup();
  const session = store.sessions.get("session-1")!;
  store.sessions.set("session-1", { ...session, queuePaused: true });
  await queue.enqueue("session-1", "wechat-owner", "first");
  await queue.enqueue("session-1", "wechat-owner", "second");
  await assert.rejects(
    queue.cancelOnlyQueued("session-1"),
    (error) => error instanceof DomainError && error.code === "queue_cancel_ambiguous"
  );
});

test("late Agent terminal notifications are idempotent after local cancellation", async () => {
  const { store, queue } = setup();
  const turn = await queue.enqueue("session-1", "wechat-owner", "first");
  assert.equal(await queue.stop("session-1"), "cancelled");
  await queue.fail(turn.id, "CANCELLED");
  await queue.complete(turn.id, "late completion must not replace cancellation");
  assert.equal(store.turns.get(turn.id)?.state, "CANCELLED");
  assert.equal(store.turns.get(turn.id)?.finalResponse, undefined);
  assert.equal(store.sessions.get("session-1")?.queuePaused, false);
});

test("closing an imported session detaches locally without archiving its native thread", async () => {
  const { store, agent, queue } = setup();
  const session = store.sessions.get("session-1")!;
  store.sessions.set("session-1", { ...session, nativeLifecycleOwner: "EXTERNAL" });
  assert.equal(await queue.close("session-1"), "closed");
  assert.deepEqual(agent.detached, ["session-1"]);
  assert.deepEqual(agent.closed, []);
});

test("closing an owned Session with no Turns deletes its native residue and local record", async () => {
  const { store, agent, queue } = setup();
  assert.equal(await queue.close("session-1"), "empty_session_deleted");
  assert.deepEqual(agent.deleted, ["session-1"]);
  assert.deepEqual(agent.closed, []);
  assert.equal(store.sessions.get("session-1"), undefined);
});

test("external Agent wait does not hold the Session linearizer", async () => {
  const store = new MemoryStateStore();
  store.sessions.set("session-1", openSession());
  let releaseSend: (() => void) | undefined;
  const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
  const agent: AgentPort = {
    capabilities: () => ({ steering: false, cancellation: true, approvals: false }),
    create: async () => ({ nativeSessionId: "native", runtimeId: "runtime" }),
    resume: async () => ({ runtimeId: "runtime", reconciledTurns: [] }),
    sendTurn: async (request) => {
      await sendGate;
      return { nativeTurnId: `native-${request.turnId}` };
    },
    steer: async () => undefined,
    cancel: async () => undefined,
    close: async () => undefined,
    detach: async () => undefined,
    deleteNativeSession: async () => undefined,
    resolveApproval: async () => undefined,
    inspectApproval: async () => ({ status: "unknown" })
  };
  const queue = new TurnQueue(
    store, agent, new FakeClock(), new FakeIdGenerator(), new SessionLinearizer()
  );
  const first = queue.enqueue("session-1", "wechat-owner", "first");
  await new Promise((resolve) => setImmediate(resolve));
  const second = await queue.enqueue("session-1", "local-cli", "second");
  assert.equal(second.state, "QUEUED");
  releaseSend?.();
  await first;
});

test("update admission gate stops every endpoint before a Turn is persisted", async () => {
  const store = new MemoryStateStore();
  store.sessions.set("session-1", openSession());
  const queue = new TurnQueue(
    store,
    new FakeAgent({ steering: true, cancellation: true, approvals: true }),
    new FakeClock(),
    new FakeIdGenerator(),
    new SessionLinearizer(),
    2,
    undefined,
    {
      assertCanStartTurn: () => {
        throw new DomainError("update_in_progress", "Update is prepared");
      }
    }
  );
  for (const endpoint of ["wechat-owner", "local-cli"]) {
    await assert.rejects(
      queue.enqueue("session-1", endpoint, "must not start"),
      (error) => error instanceof DomainError && error.code === "update_in_progress"
    );
  }
  assert.equal(store.turns.size, 0);
});

test("update admission gate also prevents an already queued Turn from dispatching", async () => {
  const store = new MemoryStateStore();
  store.sessions.set("session-1", openSession());
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  let updating = false;
  const queue = new TurnQueue(
    store,
    agent,
    new FakeClock(),
    new FakeIdGenerator(),
    new SessionLinearizer(),
    2,
    undefined,
    {
      assertCanStartTurn: () => {
        if (updating) throw new DomainError("update_in_progress", "Update is prepared");
      }
    }
  );
  const first = await queue.enqueue("session-1", "wechat-owner", "first");
  const second = await queue.enqueue("session-1", "local-cli", "second");
  updating = true;
  await queue.complete(first.id, "done");
  assert.equal(store.turns.get(second.id)?.state, "QUEUED");
  assert.equal(agent.sent.length, 1);
});
