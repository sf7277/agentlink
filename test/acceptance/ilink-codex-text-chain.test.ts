import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  SharedCodexAdapter,
  type CodexAdapterEvents
} from "../../src/agent-codex/adapter/shared-codex-adapter.js";
import { JsonlRpcClient } from "../../src/agent-codex/protocol/jsonl-rpc-client.js";
import { IlinkMonitor } from "../../src/channel-wechat/adapter/monitor.js";
import { IlinkHttpClient } from "../../src/channel-wechat/protocol/http-client.js";
import { renderRecap } from "../../src/core/application/recap.js";
import { SessionLinearizer } from "../../src/core/application/session-linearizer.js";
import { TurnQueue } from "../../src/core/application/turn-queue.js";
import {
  WechatCommandHandler,
  type WechatCommandOperations
} from "../../src/composition/wechat-command-handler.js";
import {
  FakeClock,
  FakeDigestService,
  FakeIdGenerator,
  MemoryStateStore,
  openSession
} from "../fakes/core-fakes.js";
import { FakeAppServerTransport } from "../fakes/fake-app-server.js";

test("synthetic iLink text reaches a Codex thread; reply failure never reruns the Turn", async () => {
  const transport = new FakeAppServerTransport();
  const client = new JsonlRpcClient(transport);
  await client.initialize("0.1.0");
  const store = new MemoryStateStore();
  const session = { ...openSession("session-1"), agentKind: "codex" };
  store.sessions.set(session.id, session);
  let queue: TurnQueue;
  const events: CodexAdapterEvents = {
    turnStarted: () => undefined,
    turnCompleted: (_sessionId, turnId, status, finalResponse) => {
      if (status === "completed") void queue.complete(turnId, finalResponse ?? "");
      else void queue.fail(turnId, status === "interrupted" ? "CANCELLED" : "FAILED");
    },
    approvalRequested: () => undefined,
    runtimeExited: () => undefined,
    protocolError: (error) => { throw error; }
  };
  const adapter = new SharedCodexAdapter(
    client,
    new FakeDigestService(),
    new FakeIdGenerator(),
    events,
    { projectPath: () => "/workspace", maxActiveTurns: 2 }
  );
  await adapter.create(session);
  queue = new TurnQueue(
    store,
    adapter,
    new FakeClock(),
    new FakeIdGenerator(),
    new SessionLinearizer()
  );
  const operations: WechatCommandOperations = {
    projects: async () => [{ number: 1, slug: "agentlink", allowedAgents: ["codex"] }],
    create: async () => ({ id: session.id, displayName: session.displayName }),
    imports: async () => [],
    importSession: async () => ({ id: session.id, displayName: session.displayName }),
    sessions: async () => [{
      number: 1,
      id: "s-123456",
      displayName: session.displayName,
      state: store.sessions.get(session.id)?.state ?? "UNKNOWN",
      project: "agentlink",
      nativeLifecycleOwner: "AGENTLINK",
      active: true,
      relativeTime: "now"
    }],
    use: async () => "已切换",
    attach: async (sessionId) => `已重新连接 ${sessionId}`,
    resume: async (sessionId) => `已恢复 ${sessionId}`,
    requestDelete: async (sessionId) => `待确认删除 ${sessionId}`,
    confirmDelete: async (sessionId) => `已删除 ${sessionId}`,
    status: async () => {
      const active = [...store.turns.values()].find((turn) =>
        turn.state === "RUNNING" || turn.state === "DISPATCHED"
      );
      return `${store.sessions.get(session.id)?.state} ${active?.state ?? "IDLE"}`;
    },
    recap: async () => renderRecap(
      store.sessions.get(session.id)!,
      [...store.turns.values()],
      "s-123456"
    ),
    input: async (text) => {
      const turn = await queue.enqueue(session.id, "wechat-owner", text);
      return { state: turn.state, text };
    },
    steer: async (text) => queue.steer(session.id, "wechat-owner", text),
    queue: async () => [...store.turns.values()].map((turn) => ({
      stateLabel: turn.state, summary: turn.text
    })),
    cancelQueued: async (turnId) => turnId === undefined
      ? "当前没有可取消的队列项"
      : queue.cancelQueued(session.id, turnId),
    resumeQueue: async () => queue.resumeQueue(session.id),
    approvals: async () => "暂无待审批操作",
    resolveApproval: async () => "审批已提交",
    stop: async () => queue.stop(session.id),
    close: async () => queue.close(session.id)
  };
  const handler = new WechatCommandHandler(operations);
  const body = await readFile(
    join(process.cwd(), "protocol-fixtures/ilink/getupdates-input.json"),
    "utf8"
  );
  const fetch = (async () => new Response(body, { status: 200 })) as typeof globalThis.fetch;
  const receipts = new Set<string>();
  let replyAttempts = 0;
  const monitor = new IlinkMonitor(
    new IlinkHttpClient({ baseUrl: "https://fixture.invalid", fetch }),
    "account-1",
    new Set(["fixture-owner"]),
    {
      accept: async (batch) => {
        for (const inbound of batch.messages) {
          if (inbound.disposition !== "deliver") continue;
          const receipt = inbound.message.eventId;
          if (receipts.has(receipt)) continue;
          receipts.add(receipt);
          const reply = await handler.handle(inbound.message.text ?? "");
          if (reply !== undefined) {
            replyAttempts += 1;
            try {
              throw new Error(`Injected channel send failure: ${reply}`);
            } catch {
              // Reply retry is independent of receipt and Turn execution.
            }
          }
        }
      }
    }
  );
  await monitor.pollOnce();
  await monitor.pollOnce();
  assert.equal(adapter.threadForSession(session.id), "thread-1");
  assert.equal(transport.methodCalls.filter((call) => call.method === "turn/start").length, 1);
  assert.equal(replyAttempts, 0);
  const running = [...store.turns.values()][0]!;
  transport.completeTurn("thread-1", running.nativeTurnId!, "fixture result");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match((await handler.handle("/recap")) ?? "", /上次结果：fixture result/u);
  assert.equal(transport.methodCalls.filter((call) => call.method === "turn/start").length, 1);
  await transport.close();
});
