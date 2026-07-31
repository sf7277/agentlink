import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GatewayRecoveryService
} from "../../src/core/application/gateway-recovery-service.js";
import {
  FakeClock,
  FakeProcessRegistry,
  MemoryStateStore,
  openSession
} from "../fakes/core-fakes.js";

test("Gateway restart pauses persisted work, reclaims opaque stdio child and requires explicit resume", async () => {
  const store = new MemoryStateStore();
  store.sessions.set("session-1", {
    ...openSession("session-1"),
    nativeSessionId: "thread-1",
    runtimeId: "runtime-old"
  });
  store.turns.set("turn-1", {
    id: "turn-1",
    sessionId: "session-1",
    state: "RUNNING",
    inputSequence: 1,
    sourceEndpointId: "wechat",
    text: "work",
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z"
  });
  const processes = new FakeProcessRegistry([{
    runtimeId: "runtime-old",
    alive: true,
    affectedSessionIds: ["session-1"]
  }]);
  const report = await new GatewayRecoveryService(
    store,
    processes,
    new FakeClock()
  ).recover();
  assert.equal(store.sessions.get("session-1")?.state, "UNKNOWN");
  assert.equal(store.sessions.get("session-1")?.queuePaused, true);
  assert.equal(store.turns.get("turn-1")?.state, "UNKNOWN");
  assert.deepEqual(processes.stopped, ["runtime-old"]);
  assert.deepEqual(report, {
    reclaimedRuntimeIds: ["runtime-old"],
    explicitResumeSessionIds: ["session-1"]
  });
});
