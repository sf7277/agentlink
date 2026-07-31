import assert from "node:assert/strict";
import { test } from "node:test";
import { IdentityService } from "../../src/core/application/identity-service.js";
import { SessionLinearizer } from "../../src/core/application/session-linearizer.js";
import { TurnQueue } from "../../src/core/application/turn-queue.js";
import type { ChannelMessage } from "../../src/core/contracts/ports.js";
import {
  FakeAgent,
  FakeChannel,
  FakeClock,
  FakeIdGenerator,
  MemoryStateStore,
  openSession
} from "../fakes/core-fakes.js";

test("Fake Channel and local endpoint share one ordered Session input stream", async () => {
  const store = new MemoryStateStore();
  store.sessions.set("session-1", openSession());
  store.sessions.set("session-2", openSession("session-2"));
  const agentA = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  const agentB = new FakeAgent({ steering: false, cancellation: true, approvals: false });
  const linearizer = new SessionLinearizer();
  const ids = new FakeIdGenerator();
  const queueA = new TurnQueue(
    store, agentA, new FakeClock(), ids, linearizer
  );
  const queueB = new TurnQueue(
    store, agentB, new FakeClock(), ids, linearizer
  );
  const identities = new IdentityService([
    { accountId: "fake-wechat", senderId: "owner", gatewayUserId: "owner" }
  ]);
  const channel = new FakeChannel();
  const receipts = new Set<string>();
  await channel.start(async (message: ChannelMessage) => {
    identities.authorize(message.accountId, message.senderId);
    const receipt = `${message.accountId}\u0000${message.messageId}`;
    if (receipts.has(receipt)) return;
    receipts.add(receipt);
    const queue = message.conversationId === "conversation-2" ? queueB : queueA;
    const sessionId = message.conversationId === "conversation-2" ? "session-2" : "session-1";
    await queue.enqueue(sessionId, "fake-wechat-owner", message.text ?? "");
    await channel.send({ conversationId: message.conversationId, text: "accepted" });
  });
  const message: ChannelMessage = {
    eventId: "event-1", accountId: "fake-wechat", senderId: "owner",
    conversationId: "conversation-1", messageId: "message-1", text: "from mobile",
    receivedAt: "2026-07-18T00:00:00.000Z"
  };
  channel.failSends = true;
  await assert.rejects(channel.receive(message), /send failure/u);
  await queueA.enqueue("session-1", "local-cli", "from local");
  channel.failSends = false;
  await Promise.all([
    channel.receive(message),
    channel.receive({
      ...message,
      eventId: "event-2",
      conversationId: "conversation-2",
      messageId: "message-2",
      text: "second agent"
    })
  ]);
  const turns = [...store.turns.values()]
    .filter((turn) => turn.sessionId === "session-1")
    .sort((a, b) => a.inputSequence - b.inputSequence);
  assert.equal(store.turns.size, 3);
  assert.deepEqual(turns.map((turn) => turn.sourceEndpointId), [
    "fake-wechat-owner", "local-cli"
  ]);
  assert.deepEqual(turns.map((turn) => turn.state), ["RUNNING", "QUEUED"]);
  assert.equal(agentA.sent.length, 1);
  assert.equal(agentB.sent.length, 1);
});
