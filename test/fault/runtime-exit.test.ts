import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeFailureService } from "../../src/core/application/runtime-failure-service.js";
import { SessionLinearizer } from "../../src/core/application/session-linearizer.js";
import type { Turn } from "../../src/core/domain/model.js";
import { FakeClock, MemoryStateStore, openSession } from "../fakes/core-fakes.js";

test("shared Runtime exit marks every affected active Turn UNKNOWN and pauses queues", async () => {
  const store = new MemoryStateStore();
  const now = "2026-07-18T00:00:00.000Z";
  for (const sessionId of ["session-1", "session-2"]) {
    store.sessions.set(sessionId, { ...openSession(sessionId), runtimeId: "runtime-shared" });
    const active: Turn = {
      id: `${sessionId}-active`, sessionId, state: "RUNNING", inputSequence: 1,
      sourceEndpointId: "owner", text: "active", createdAt: now, updatedAt: now
    };
    const queued: Turn = {
      id: `${sessionId}-queued`, sessionId, state: "QUEUED", inputSequence: 2, queueSequence: 2,
      sourceEndpointId: "owner", text: "queued", createdAt: now, updatedAt: now
    };
    store.turns.set(active.id, active);
    store.turns.set(queued.id, queued);
  }
  await new RuntimeFailureService(store, new FakeClock(), new SessionLinearizer()).handleExit({
    runtimeId: "runtime-shared",
    alive: false,
    affectedSessionIds: ["session-1", "session-2"]
  });
  assert.deepEqual([...store.sessions.values()].map((session) => session.state), ["UNKNOWN", "UNKNOWN"]);
  assert.deepEqual([...store.turns.values()].map((turn) => turn.state), [
    "UNKNOWN", "PAUSED", "UNKNOWN", "PAUSED"
  ]);
});
