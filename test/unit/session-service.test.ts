import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionLinearizer } from "../../src/core/application/session-linearizer.js";
import { SessionService } from "../../src/core/application/session-service.js";
import {
  AgentAuthenticationRequiredError,
  AgentOperationUncertainError
} from "../../src/core/domain/errors.js";
import {
  FakeAgent,
  FakeClock,
  FakeIdGenerator,
  MemoryStateStore,
  openSession
} from "../fakes/core-fakes.js";

test("Session create persists intent before Agent call and resolves native identity", async () => {
  const store = new MemoryStateStore();
  const service = new SessionService(
    store,
    new FakeAgent({ steering: true, cancellation: true, approvals: true }),
    new FakeClock(),
    new FakeIdGenerator(),
    new SessionLinearizer()
  );
  const session = await service.create("project-1", "fake");
  assert.equal(session.state, "OPEN");
  assert.equal(session.runtimeState, "ALIVE");
  assert.equal(session.nativeSessionId, `native-${session.id}`);
});

test("uncertain Agent create leaves persisted Session UNKNOWN", async () => {
  const store = new MemoryStateStore();
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  agent.create = async () => { throw new Error("uncertain"); };
  const service = new SessionService(
    store, agent, new FakeClock(), new FakeIdGenerator(), new SessionLinearizer()
  );
  await assert.rejects(service.create("project-1", "fake"), /uncertain/u);
  const session = [...store.sessions.values()][0];
  assert.equal(session?.state, "UNKNOWN");
  assert.equal(session?.runtimeState, "UNKNOWN");
});

test("definite Agent authentication rejection removes provisional Session", async () => {
  const store = new MemoryStateStore();
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  agent.create = async () => {
    throw new AgentAuthenticationRequiredError("Grok", "grok login");
  };
  const service = new SessionService(
    store, agent, new FakeClock(), new FakeIdGenerator(), new SessionLinearizer()
  );

  await assert.rejects(
    service.create("project-1", "grok"),
    (error: unknown) =>
      error instanceof AgentAuthenticationRequiredError &&
      error.code === "agent_authentication_required" &&
      error.message === "Grok认证已失效，请在本机执行 grok login 后重试"
  );
  assert.equal(store.sessions.size, 0);
});

test("Session resume applies native terminal reconciliation before reopening", async () => {
  const store = new MemoryStateStore();
  store.sessions.set("session-1", {
    ...openSession("session-1"),
    nativeSessionId: "thread-1",
    state: "UNKNOWN",
    runtimeState: "EXITED",
    queuePaused: true
  });
  store.turns.set("turn-1", {
    id: "turn-1",
    sessionId: "session-1",
    nativeTurnId: "native-turn-1",
    state: "UNKNOWN",
    inputSequence: 1,
    sourceEndpointId: "wechat-owner",
    text: "work",
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z"
  });
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  agent.resume = async (_session, turns) => ({
    runtimeId: "runtime-restarted",
    reconciledTurns: turns.map((turn) => ({
      turnId: turn.id,
      state: "CANCELLED" as const
    }))
  });
  const service = new SessionService(
    store, agent, new FakeClock(), new FakeIdGenerator(), new SessionLinearizer()
  );

  const resumed = await service.resume("session-1");
  assert.equal(resumed.state, "OPEN");
  assert.equal(resumed.runtimeState, "ALIVE");
  assert.equal(resumed.runtimeId, "runtime-restarted");
  assert.equal(store.turns.get("turn-1")?.state, "CANCELLED");
});

test("Session resume distinguishes verified running work from truly unknown work", async () => {
  const setup = (nativeState: "RUNNING" | "UNKNOWN") => {
    const store = new MemoryStateStore();
    store.sessions.set("session-1", {
      ...openSession("session-1"),
      nativeSessionId: "thread-1",
      state: "UNKNOWN",
      runtimeState: "UNKNOWN",
      queuePaused: true
    });
    store.turns.set("turn-1", {
      id: "turn-1",
      sessionId: "session-1",
      nativeTurnId: "native-turn-1",
      state: "UNKNOWN",
      inputSequence: 1,
      sourceEndpointId: "wechat-owner",
      text: "work",
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z"
    });
    const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
    agent.resume = async () => ({
      runtimeId: "runtime-restarted",
      reconciledTurns: [{ turnId: "turn-1", state: nativeState }]
    });
    return {
      store,
      service: new SessionService(
        store, agent, new FakeClock(), new FakeIdGenerator(), new SessionLinearizer()
      )
    };
  };

  const running = setup("RUNNING");
  assert.equal((await running.service.resume("session-1")).state, "OPEN");
  assert.equal(running.store.turns.get("turn-1")?.state, "RUNNING");

  const unknown = setup("UNKNOWN");
  const unresolved = await unknown.service.resume("session-1");
  assert.equal(unresolved.state, "UNKNOWN");
  assert.equal(unresolved.runtimeState, "ALIVE");
  assert.equal(unknown.store.turns.get("turn-1")?.state, "UNKNOWN");
});

test("definite closed Session resume failure restores the original closed state", async () => {
  const store = new MemoryStateStore();
  const original = {
    ...openSession("session-1"),
    nativeSessionId: "thread-1",
    state: "CLOSED" as const,
    runtimeState: "UNKNOWN" as const,
    queuePaused: true
  };
  store.sessions.set(original.id, original);
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  agent.resume = async () => { throw new Error("definite resume failure"); };
  const service = new SessionService(
    store, agent, new FakeClock(), new FakeIdGenerator(), new SessionLinearizer()
  );

  await assert.rejects(service.resume(original.id), /definite resume failure/u);
  assert.equal(store.sessions.get(original.id)?.state, "CLOSED");
  assert.equal(store.sessions.get(original.id)?.queuePaused, true);
});

test("uncertain closed Session resume failure is marked UNKNOWN", async () => {
  const store = new MemoryStateStore();
  const original = {
    ...openSession("session-1"),
    nativeSessionId: "thread-1",
    state: "CLOSED" as const,
    runtimeState: "UNKNOWN" as const,
    queuePaused: true
  };
  store.sessions.set(original.id, original);
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  agent.resume = async () => {
    throw new AgentOperationUncertainError("rollback failed");
  };
  const service = new SessionService(
    store, agent, new FakeClock(), new FakeIdGenerator(), new SessionLinearizer()
  );

  await assert.rejects(service.resume(original.id), /rollback failed/u);
  assert.equal(store.sessions.get(original.id)?.state, "UNKNOWN");
  assert.equal(store.sessions.get(original.id)?.runtimeState, "UNKNOWN");
});

test("external Session import persists only the verified native mapping and no historical Turns", async () => {
  const store = new MemoryStateStore();
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  agent.externalSessions = [{
    nativeSessionId: "thread-existing",
    displayName: "既有会话",
    lastActivityAt: "2026-07-17T20:00:00.000Z",
    archived: false
  }];
  const service = new SessionService(
    store, agent, new FakeClock(), new FakeIdGenerator(), new SessionLinearizer()
  );
  assert.deepEqual(await service.discoverExternal("project-1"), agent.externalSessions);
  const imported = await service.importExternal("project-1", "codex", agent.externalSessions[0]!);
  assert.equal(imported.state, "OPEN");
  assert.equal(imported.runtimeState, "ALIVE");
  assert.equal(imported.nativeSessionId, "thread-existing");
  assert.equal(imported.displayName, "既有会话");
  assert.equal(imported.lastActivityAt, "2026-07-17T20:00:00.000Z");
  assert.deepEqual(store.turns.size, 0);
});

test("failed external Session import removes its provisional AgentLink record", async () => {
  const store = new MemoryStateStore();
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  agent.importExternalSession = async () => {
    throw new Error("native verification failed");
  };
  const service = new SessionService(
    store, agent, new FakeClock(), new FakeIdGenerator(), new SessionLinearizer()
  );
  await assert.rejects(
    service.importExternal("project-1", "codex", {
      nativeSessionId: "thread-existing",
      displayName: "既有会话",
      lastActivityAt: "2026-07-17T20:00:00.000Z",
      archived: false
    }),
    /native verification failed/u
  );
  assert.equal(store.sessions.size, 0);
});

test("bounded external import persists continuation ownership and source provenance", async () => {
  const store = new MemoryStateStore();
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  agent.importExternalSession = async (_session, candidate) => ({
    nativeSessionId: "thread-continuation",
    sourceNativeSessionId: candidate.nativeSessionId,
    nativeLifecycleOwner: "AGENTLINK" as const,
    historyTruncated: true,
    runtimeId: "runtime-1",
    displayName: candidate.displayName,
    lastActivityAt: candidate.lastActivityAt
  });
  const service = new SessionService(
    store, agent, new FakeClock(), new FakeIdGenerator(), new SessionLinearizer()
  );
  const imported = await service.importExternal("project-1", "codex", {
    nativeSessionId: "thread-source",
    displayName: "大型会话",
    lastActivityAt: "2026-07-17T20:00:00.000Z",
    archived: false
  });
  assert.equal(imported.nativeSessionId, "thread-continuation");
  assert.equal(imported.sourceNativeSessionId, "thread-source");
  assert.equal(imported.nativeLifecycleOwner, "AGENTLINK");
  assert.equal(imported.historyTruncated, true);
});

test("owned idle Session deletion does not require archive and removes native state first", async () => {
  const store = new MemoryStateStore();
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  const service = new SessionService(
    store, agent, new FakeClock(), new FakeIdGenerator(), new SessionLinearizer()
  );
  store.sessions.set("session-1", { ...openSession(), nativeSessionId: "thread-1" });
  await service.deleteOwned("session-1");
  assert.deepEqual(agent.deleted, ["session-1"]);
  assert.equal(store.sessions.has("session-1"), false);
});

test("external Session detach clears only its native mapping", async () => {
  const store = new MemoryStateStore();
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  store.sessions.set("session-1", {
    ...openSession(), nativeSessionId: "thread-external", runtimeId: "runtime-1",
    sourceNativeSessionId: "thread-external", historyTruncated: false,
    nativeLifecycleOwner: "EXTERNAL"
  });
  const service = new SessionService(
    store, agent, new FakeClock(), new FakeIdGenerator(), new SessionLinearizer()
  );
  const detached = await service.detachExternal("session-1");
  assert.equal(detached.nativeSessionId, undefined);
  assert.equal(detached.runtimeId, undefined);
  assert.equal(detached.sourceNativeSessionId, undefined);
  assert.equal(detached.historyTruncated, false);
  assert.equal(detached.state, "CLOSED");
  assert.deepEqual(agent.detached, ["session-1"]);
  assert.deepEqual(agent.deleted, []);
});
