import assert from "node:assert/strict";
import { test } from "node:test";
import { RestartableAgentPort } from "../../src/composition/restartable-agent-port.js";
import { FakeAgent } from "../fakes/core-fakes.js";

test("restartable Agent port blocks dispatch while unavailable and routes to a replacement", async () => {
  const capabilities = { steering: true, cancellation: true, approvals: true };
  const proxy = new RestartableAgentPort(capabilities);
  const request = {
    sessionId: "session-1",
    turnId: "turn-1",
    text: "work"
  };

  assert.deepEqual(proxy.capabilities(), capabilities);
  assert.equal(proxy.available(), false);
  await assert.rejects(
    async () => proxy.sendTurn(request),
    /Runtime is restarting/u
  );

  const first = new FakeAgent(capabilities);
  proxy.install(first);
  await proxy.sendTurn(request);
  assert.deepEqual(first.sent, [request]);

  proxy.clear();
  const replacement = new FakeAgent(capabilities);
  proxy.install(replacement);
  await proxy.sendTurn({ ...request, turnId: "turn-2" });
  assert.equal(first.sent.length, 1);
  assert.equal(replacement.sent[0]?.turnId, "turn-2");
});
