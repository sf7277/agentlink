import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalBroker } from "../../src/core/application/approval-broker.js";
import { MobileAttachmentService } from "../../src/core/application/mobile-attachment-service.js";
import { SessionLinearizer } from "../../src/core/application/session-linearizer.js";
import { TurnQueue } from "../../src/core/application/turn-queue.js";
import type {
  ApprovalAuditPort,
  ApprovalAuditRecord,
  ApprovalLeaseEffects
} from "../../src/core/contracts/ports.js";
import type { AgentApprovalRequest } from "../../src/core/domain/model.js";
import {
  FakeAgent,
  FakeClock,
  FakeIdGenerator,
  MemoryStateStore,
  openSession
} from "../fakes/core-fakes.js";

const noLeaseEffects: ApprovalLeaseEffects = {
  expireMobileWrite: () => undefined,
  restoreMobileWrite: () => undefined
};

class MemoryAudit implements ApprovalAuditPort {
  readonly records: ApprovalAuditRecord[] = [];
  public appendApprovalAudit(record: ApprovalAuditRecord): void {
    this.records.push(record);
  }
}

function request(id = "request-1", sessionId = "session-1"): AgentApprovalRequest {
  return {
    id,
    nativeRequestId: "native-request-1",
    nativeItemId: "item-1",
    sessionId,
    turnId: "turn-1",
    actionKind: "command",
    actionDigest: "digest-1",
    summary: "run command",
    risk: "high",
    observedAt: "2026-07-19T00:00:00.000Z"
  };
}

test("Approval Broker audits before one-shot CAS and rejects a concurrent replay", async () => {
  const clock = new FakeClock("2026-07-19T00:00:00.000Z");
  const audit = new MemoryAudit();
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  const broker = new ApprovalBroker(
    agent, audit, clock, new FakeIdGenerator(), new SessionLinearizer(), noLeaseEffects
  );
  const lease = broker.observe(request(), "wechat-owner", 60_000);
  const input = {
    leaseId: lease.id,
    controllerEndpointId: "wechat-owner",
    sessionId: "session-1",
    decision: "allow_once" as const
  };
  const results = await Promise.allSettled([broker.resolve(input), broker.resolve(input)]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  assert.deepEqual(agent.decisions, [{ requestId: "request-1", decision: "allow_once" }]);
  assert.equal(audit.records.length, 1);
  assert.equal(audit.records[0]?.observedState, "decision_recorded");
});

test("Approval Broker exposes a dispatched deny exactly once to terminal reconciliation", async () => {
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  const broker = new ApprovalBroker(
    agent,
    new MemoryAudit(),
    new FakeClock("2026-07-19T00:00:00.000Z"),
    new FakeIdGenerator(),
    new SessionLinearizer(),
    noLeaseEffects
  );
  const lease = broker.observe(request(), "wechat-owner", 60_000);
  let decisionDuringDispatch: string | undefined;
  agent.onResolveApproval = () => {
    decisionDuringDispatch = broker.consumeDispatchedDecision("turn-1");
  };

  await broker.resolve({
    leaseId: lease.id,
    controllerEndpointId: "wechat-owner",
    sessionId: "session-1",
    decision: "deny"
  });

  assert.equal(decisionDuringDispatch, "deny");
  assert.equal(broker.consumeDispatchedDecision("turn-1"), undefined);
});

test("bare approval resolves one active item and rejects ambiguity", async () => {
  const clock = new FakeClock("2026-07-19T00:00:00.000Z");
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  const broker = new ApprovalBroker(
    agent, new MemoryAudit(), clock, new FakeIdGenerator(),
    new SessionLinearizer(), noLeaseEffects
  );
  broker.observe(request("request-one"), "wechat-owner", 60_000);
  await broker.resolveForController({
    controllerEndpointId: "wechat-owner",
    decision: "allow_once"
  });
  assert.deepEqual(agent.decisions, [{ requestId: "request-one", decision: "allow_once" }]);

  broker.observe(request("request-two", "session-2"), "wechat-owner", 60_000);
  broker.observe(request("request-three", "session-3"), "wechat-owner", 60_000);
  assert.equal(broker.activeForController("wechat-owner").length, 2);
  await assert.rejects(
    broker.resolveForController({
      controllerEndpointId: "wechat-owner",
      decision: "deny"
    }),
    /多个待审批项/u
  );
  assert.equal(agent.decisions.length, 1);
});

test("expired, cross-Session and cross-controller approvals never reach AgentPort", async () => {
  const clock = new FakeClock("2026-07-19T00:00:00.000Z");
  const audit = new MemoryAudit();
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  const broker = new ApprovalBroker(
    agent, audit, clock, new FakeIdGenerator(), new SessionLinearizer(), noLeaseEffects
  );
  const lease = broker.observe(request(), "wechat-owner", 60_000);
  await assert.rejects(
    broker.resolve({
      leaseId: lease.id, controllerEndpointId: "wechat-owner",
      sessionId: "session-other", decision: "deny"
    }),
    (error: unknown) => error instanceof Error && error.message.includes("another Session")
  );
  await assert.rejects(
    broker.resolve({
      leaseId: lease.id, controllerEndpointId: "local-other",
      sessionId: "session-1", decision: "deny"
    }),
    (error: unknown) => error instanceof Error && error.message.includes("another controller")
  );
  clock.set("2026-07-19T00:01:00.000Z");
  await assert.rejects(
    broker.resolve({
      leaseId: lease.id, controllerEndpointId: "wechat-owner",
      sessionId: "session-1", decision: "deny"
    }),
    (error: unknown) => error instanceof Error && error.message.includes("expired")
  );
  assert.deepEqual(agent.decisions, []);
  assert.deepEqual(audit.records, []);
});

test("audit failure leaves the approval pending and prevents Agent response", async () => {
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  const audit: ApprovalAuditPort = {
    appendApprovalAudit: () => { throw new Error("disk full"); }
  };
  const broker = new ApprovalBroker(
    agent,
    audit,
    new FakeClock("2026-07-19T00:00:00.000Z"),
    new FakeIdGenerator(),
    new SessionLinearizer(),
    noLeaseEffects
  );
  const lease = broker.observe(request(), "wechat-owner", 60_000);
  await assert.rejects(
    broker.resolve({
      leaseId: lease.id, controllerEndpointId: "wechat-owner",
      sessionId: "session-1", decision: "deny"
    }),
    /disk full/u
  );
  assert.equal(broker.lease(lease.id)?.state, "ACTIVE");
  assert.deepEqual(agent.decisions, []);
});

test("a changed native action revokes the old short ID", async () => {
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  const broker = new ApprovalBroker(
    agent,
    new MemoryAudit(),
    new FakeClock("2026-07-19T00:00:00.000Z"),
    new FakeIdGenerator(),
    new SessionLinearizer(),
    noLeaseEffects
  );
  const oldLease = broker.observe(request("request-old"), "wechat-owner", 60_000);
  const changed = {
    ...request("request-new"),
    nativeRequestId: "native-request-2",
    actionDigest: "digest-2"
  };
  broker.observe(changed, "wechat-owner", 60_000);
  assert.equal(broker.lease(oldLease.id)?.state, "REVOKED");
  await assert.rejects(
    broker.resolve({
      leaseId: oldLease.id,
      controllerEndpointId: "wechat-owner",
      sessionId: "session-1",
      decision: "allow_once"
    }),
    (error: unknown) => error instanceof Error && error.message.includes("already resolved")
  );
  await assert.rejects(
    broker.reattach("session-1", "wechat-owner", 60_000),
    /exactly one expired/u
  );
  assert.deepEqual(agent.decisions, []);
});

test("lease expiry detaches mobile write, pauses queued Turns, and never denies Agent", async () => {
  const store = new MemoryStateStore();
  store.sessions.set("session-1", openSession());
  store.turns.set("turn-1", {
    id: "turn-1", sessionId: "session-1", state: "WAITING_AGENT_APPROVAL",
    inputSequence: 1, sourceEndpointId: "wechat-owner", text: "first",
    createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z"
  });
  store.turns.set("turn-2", {
    id: "turn-2", sessionId: "session-1", state: "QUEUED",
    inputSequence: 2, queueSequence: 2, sourceEndpointId: "local", text: "second",
    createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z"
  });
  const clock = new FakeClock("2026-07-19T00:00:00.000Z");
  const attachments = new MobileAttachmentService(store, clock);
  attachments.attachInitial("session-1", "wechat-owner");
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  const broker = new ApprovalBroker(
    agent, new MemoryAudit(), clock, new FakeIdGenerator(),
    new SessionLinearizer(), attachments
  );
  const lease = broker.observe(request(), "wechat-owner", 60_000);
  clock.set("2026-07-19T00:01:00.000Z");
  const expired = await broker.expireLeases();
  assert.deepEqual(expired.map((item) => item.id), [lease.id]);
  assert.equal(broker.lease(lease.id)?.state, "EXPIRED");
  assert.equal(attachments.isAttached("session-1", "wechat-owner"), false);
  assert.equal(store.sessions.get("session-1")?.queuePaused, true);
  assert.equal(store.turns.get("turn-1")?.state, "WAITING_AGENT_APPROVAL");
  assert.equal(store.turns.get("turn-2")?.state, "PAUSED");
  assert.deepEqual(agent.decisions, []);
  assert.throws(() => attachments.assertWritable("session-1", "wechat-owner"));
  const queue = new TurnQueue(
    store, agent, clock, new FakeIdGenerator(), new SessionLinearizer(), 32, attachments
  );
  await assert.rejects(
    queue.enqueue("session-1", "wechat-owner", "blocked mobile input"),
    /must attach/u
  );
  const local = await queue.enqueue("session-1", "local-cli", "local inspection");
  assert.equal(local.state, "PAUSED");

  const renewed = await broker.reattach("session-1", "wechat-owner", 60_000);
  assert.notEqual(renewed.id, lease.id);
  assert.equal(broker.lease(lease.id)?.state, "EXPIRED");
  assert.equal(attachments.isAttached("session-1", "wechat-owner"), true);
  assert.equal(store.sessions.get("session-1")?.queuePaused, true);
  await assert.rejects(
    broker.resolve({
      leaseId: lease.id,
      controllerEndpointId: "wechat-owner",
      sessionId: "session-1",
      decision: "allow_once"
    }),
    /already resolved/u
  );
});

test("reattach is forbidden when Agent state is unknown or Runtime exited", async () => {
  const clock = new FakeClock("2026-07-19T00:00:00.000Z");
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  agent.approvalSnapshots.set("request-1", { status: "unknown" });
  const broker = new ApprovalBroker(
    agent, new MemoryAudit(), clock, new FakeIdGenerator(),
    new SessionLinearizer(), noLeaseEffects
  );
  broker.observe(request(), "wechat-owner", 1);
  clock.set("2026-07-19T00:00:00.001Z");
  await broker.expireLeases();
  await assert.rejects(
    broker.reattach("session-1", "wechat-owner", 60_000),
    /does not confirm/u
  );
  await broker.invalidateSessions(["session-1"]);
  await assert.rejects(
    broker.reattach("session-1", "wechat-owner", 60_000),
    /Runtime exited/u
  );
});
