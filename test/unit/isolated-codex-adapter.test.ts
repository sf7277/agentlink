import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IsolatedCodexAdapter
} from "../../src/agent-codex/adapter/isolated-codex-adapter.js";
import { FakeAgent, openSession } from "../fakes/core-fakes.js";

test("isolated fallback keeps one Runtime per Session behind the same AgentPort", async () => {
  const agents = new Map<string, FakeAgent>();
  const stopped: string[] = [];
  const adapter = new IsolatedCodexAdapter(async (session) => {
    const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
    agents.set(session.id, agent);
    return {
      agent,
      ownsApproval: (requestId) => requestId === `approval-${session.id}`,
      closeRuntime: async () => { stopped.push(session.id); }
    };
  });
  const sessionA = { ...openSession("session-a"), state: "CREATING" as const };
  const sessionB = { ...openSession("session-b"), state: "CREATING" as const };
  await Promise.all([adapter.create(sessionA), adapter.create(sessionB)]);
  assert.equal(adapter.runtimeCount(), 2);
  await adapter.sendTurn({ sessionId: "session-a", turnId: "turn-a", text: "A" });
  await adapter.sendTurn({ sessionId: "session-b", turnId: "turn-b", text: "B" });
  assert.equal(agents.get("session-a")?.sent.length, 1);
  assert.equal(agents.get("session-b")?.sent.length, 1);
  await adapter.resolveApproval("approval-session-b", "deny");
  assert.deepEqual(agents.get("session-b")?.decisions, [
    { requestId: "approval-session-b", decision: "deny" }
  ]);
  await adapter.close(openSession("session-a"));
  assert.equal(adapter.runtimeCount(), 1);
  assert.deepEqual(stopped, ["session-a"]);
  assert.equal(agents.get("session-b")?.closed.length, 0);
});
