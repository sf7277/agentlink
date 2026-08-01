import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  GatewayApplication,
  sessionShortId,
  sessionShortIds
} from "../../src/composition/gateway-application.js";
import { ProjectRegistry } from "../../src/core/application/project-registry.js";
import {
  AgentAuthenticationRequiredError
} from "../../src/core/domain/errors.js";
import { ControlRepository } from "../../src/storage-sqlite/control-repository.js";
import { ProjectRepository } from "../../src/storage-sqlite/project-repository.js";
import { SqliteStateStore } from "../../src/storage-sqlite/sqlite-state-store.js";
import {
  FakeAgent,
  FakeChannel,
  FakeClock,
  FakeIdGenerator
} from "../fakes/core-fakes.js";

async function createRecoveryFixture(options: {
  readonly unknownRecoveryWindowMs: number;
  readonly unknownRecoveryPollMs: number;
  readonly restartAgentRuntime?: (agentKind: string) => Promise<void>;
  readonly deleteNativeSession?: (session: import(
    "../../src/core/domain/model.js"
  ).AgentSession) => Promise<void>;
  readonly allowedAgents?: readonly string[];
  readonly defaultAgent?: string;
}) {
  const root = await mkdtemp("/tmp/agentlink-unknown-recovery-");
  const store = new SqliteStateStore(
    join(root, "state.sqlite3"),
    join(process.cwd(), "migrations")
  );
  const clock = new FakeClock();
  const ids = new FakeIdGenerator();
  const control = new ControlRepository(store.database);
  const projects = new ProjectRepository(store.database);
  const registry = new ProjectRegistry();
  const project = await registry.register({
    id: "project-1",
    slug: "agentlink",
    path: root,
    allowedAgents: options.allowedAgents ?? ["codex"],
    defaultAgent: options.defaultAgent ?? "codex"
  });
  projects.put({
    id: project.id,
    slug: project.slug,
    canonicalPath: project.canonicalPath,
    allowedAgents: project.allowedAgents,
    defaultAgent: project.defaultAgent,
    enabled: true,
    createdAt: clock.now()
  });
  control.putChannelAccount(
    "account-1",
    "wechat-token",
    [{ senderId: "owner-1", gatewayUserId: "user-1" }],
    clock.now()
  );
  const channel = new FakeChannel();
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  const diagnostics: string[] = [];
  const application = new GatewayApplication(
    store,
    control,
    projects,
    registry,
    channel,
    agent,
    clock,
    ids,
    {
      accountId: "account-1",
      identities: [{
        accountId: "account-1",
        senderId: "owner-1",
        gatewayUserId: "user-1"
      }],
      approvalLeaseMs: 300_000,
      queueLimit: 32,
      unknownRecoveryWindowMs: options.unknownRecoveryWindowMs,
      unknownRecoveryPollMs: options.unknownRecoveryPollMs,
      ...(options.restartAgentRuntime === undefined
        ? {}
        : { restartAgentRuntime: options.restartAgentRuntime }),
      ...(options.deleteNativeSession === undefined
        ? {}
        : { deleteNativeSession: options.deleteNativeSession }),
      publishLocal: () => undefined,
      onDiagnostic: (kind) => diagnostics.push(kind)
    }
  );
  const message = (messageId: string, text: string) => application.handleChannelMessage({
    eventId: `event-${messageId}`,
    accountId: "account-1",
    senderId: "owner-1",
    conversationId: "conversation-1",
    messageId,
    text,
    receivedAt: clock.now()
  });
  return { store, channel, agent, diagnostics, application, message };
}

test("product composition creates a Session, deduplicates mobile input and resolves exact approval", async () => {
  const root = await mkdtemp("/tmp/agentlink-composition-");
  const store = new SqliteStateStore(
    join(root, "state.sqlite3"),
    join(process.cwd(), "migrations")
  );
  const clock = new FakeClock();
  const ids = new FakeIdGenerator();
  const control = new ControlRepository(store.database);
  const projects = new ProjectRepository(store.database);
  const registry = new ProjectRegistry();
  const project = await registry.register({
    id: "project-1",
    slug: "agentlink",
    path: root,
    allowedAgents: ["codex"],
    defaultAgent: "codex"
  });
  projects.put({
    id: project.id,
    slug: project.slug,
    canonicalPath: project.canonicalPath,
    allowedAgents: project.allowedAgents,
    defaultAgent: project.defaultAgent,
    enabled: true,
    createdAt: clock.now()
  });
  control.putChannelAccount(
    "account-1",
    "wechat-token",
    [{ senderId: "owner-1", gatewayUserId: "user-1" }],
    clock.now()
  );
  const channel = new FakeChannel();
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  const diagnostics: string[] = [];
  const application = new GatewayApplication(
    store,
    control,
    projects,
    registry,
    channel,
    agent,
    clock,
    ids,
    {
      accountId: "account-1",
      identities: [{
        accountId: "account-1",
        senderId: "owner-1",
        gatewayUserId: "user-1"
      }],
      approvalLeaseMs: 300_000,
      queueLimit: 32,
      publishLocal: () => undefined,
      onDiagnostic: (kind) => diagnostics.push(kind)
    }
  );
  const message = (messageId: string, text: string) => application.handleChannelMessage({
    eventId: `event-${messageId}`,
    accountId: "account-1",
    senderId: "owner-1",
    conversationId: "conversation-1",
    messageId,
    text,
    receivedAt: clock.now()
  });

  await message("m1", "/new codex agentlink");
  assert.equal(
    channel.sent.at(-1)?.text,
    `已创建并绑定：agentlink · 新会话（${sessionShortId("session-1")}）`
  );
  await message("m-list", "/sessions");
  assert.match(channel.sent.at(-1)?.text ?? "", new RegExp(sessionShortId("session-1"), "u"));
  assert.doesNotMatch(channel.sent.at(-1)?.text ?? "", /session-1/u);
  assert.match(channel.sent.at(-1)?.text ?? "", /1\. \* agentlink · 新会话/u);
  assert.match(
    channel.sent.at(-1)?.text ?? "",
    new RegExp(`now\\(${sessionShortId("session-1")}\\)$`, "u")
  );
  const repliesBeforeInput = channel.sent.length;
  await message("m2", "真实链路输入");
  await message("m2", "真实链路输入");
  assert.equal(agent.sent.length, 1);
  assert.equal(agent.sent[0]?.text, "真实链路输入");
  assert.equal(channel.sent.length, repliesBeforeInput);
  assert.equal(
    store.transaction((transaction) => transaction.getSession("session-1"))?.displayName,
    "真实链路输入"
  );
  application.threadNameUpdated("session-1", "修复移动端会话体验");
  await message("m-renamed", "/sessions");
  assert.match(channel.sent.at(-1)?.text ?? "", /修复移动端会话体验/u);

  const completeApprovalSummary = `Codex请求执行命令：/bin/zsh -lc '${"echo safe-step ".repeat(18)}--final-marker'`;
  application.approvalRequested({
    id: "approval-request-1",
    nativeRequestId: "native-request-1",
    nativeItemId: "item-1",
    sessionId: "session-1",
    turnId: agent.sent[0]!.turnId,
    actionKind: "command",
    actionDigest: "digest-1",
    summary: completeApprovalSummary,
    risk: "high",
    observedAt: clock.now()
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    store.transaction((transaction) => transaction.getTurn(agent.sent[0]!.turnId))?.state,
    "WAITING_AGENT_APPROVAL"
  );
  const approvalText = channel.sent.at(-1)?.text ?? "";
  assert.match(approvalText, /允许 \/approve · 拒绝 \/deny · 停止 \/cancel/u);
  assert.ok(approvalText.includes(completeApprovalSummary));
  assert.doesNotMatch(approvalText, /…/u);
  assert.doesNotMatch(approvalText, /approval-|request-/u);
  await message("m3", "/approve");
  assert.deepEqual(agent.decisions, [{
    requestId: "approval-request-1",
    decision: "allow_once"
  }]);
  assert.equal(
    store.transaction((transaction) => transaction.getTurn(agent.sent[0]!.turnId))?.state,
    "RUNNING"
  );
  await message("m-queued", "12345678901234567890A");
  assert.match(channel.sent.at(-1)?.text ?? "", /已加入等待队列：12345678901234567890…/u);
  await message("m-queue", "/queue");
  assert.match(channel.sent.at(-1)?.text ?? "", /1\. 等待 · 12345678901234567890…/u);
  assert.doesNotMatch(channel.sent.at(-1)?.text ?? "", /turn-/u);
  await message("m-queued-2", "second queued item");
  await message("m-cancel-ambiguous", "/queue cancel");
  assert.equal(
    channel.sent.at(-1)?.text,
    "请求失败：存在多个可取消任务，请使用 /queue 查看后指定编号"
  );
  await message("m-cancel-stale", "/queue cancel 1");
  assert.equal(channel.sent.at(-1)?.text, "请求失败：队列已变化，请重新使用 /queue");
  await message("m-queue-refresh", "/queue");
  await message("m-cancel", "/queue cancel 1");
  assert.match(channel.sent.at(-1)?.text ?? "", /已取消：12345678901234567890…/u);
  await message("m-cancel-only", "/queue cancel");
  assert.equal(channel.sent.at(-1)?.text, "已取消：second queued item");
  await message("m-cancel-empty", "/queue cancel");
  assert.equal(channel.sent.at(-1)?.text, "当前没有可取消的队列项");
  store.reconcileStartup("2026-07-18T00:01:00.000Z");
  await message("m-state", "/sessions");
  assert.match(channel.sent.at(-1)?.text ?? "", /状态待核实/u);
  assert.doesNotMatch(channel.sent.at(-1)?.text ?? "", /已关闭/u);
  agent.resume = async (_session, turns) => ({
    runtimeId: "runtime-1",
    reconciledTurns: turns
      .filter((turn) => turn.state === "UNKNOWN")
      .map((turn) => ({ turnId: turn.id, state: "COMPLETED" as const }))
  });
  await message("m4", "/use 1");
  assert.match(channel.sent.at(-1)?.text ?? "", /已恢复并切换：修复移动端会话体验/u);
  assert.equal(
    store.transaction((transaction) => transaction.getSession("session-1"))?.state,
    "OPEN"
  );
  assert.equal(
    store.transaction((transaction) => transaction.getSession("session-1"))?.queuePaused,
    false
  );
  const sentBeforeRecoveredInput = agent.sent.length;
  const repliesBeforeRecoveredInput = channel.sent.length;
  await message("m-recovered-input", "恢复后直接对话");
  assert.equal(agent.sent.length, sentBeforeRecoveredInput + 1);
  assert.equal(channel.sent.length, repliesBeforeRecoveredInput);
  assert.deepEqual(diagnostics, [
    "channel_command_failed",
    "channel_command_failed"
  ]);
  store.close();
});

test("external native deletion removes the mobile Session, binding and local resources", async () => {
  let restarts = 0;
  const { store, channel, agent, message } = await createRecoveryFixture({
    unknownRecoveryWindowMs: 100,
    unknownRecoveryPollMs: 5,
    restartAgentRuntime: async (kind) => {
      assert.equal(kind, "codex");
      restarts += 1;
    }
  });

  await message("delete-new", "/new codex agentlink");
  await message("delete-input", "待清理的本地资源");
  assert.equal(
    store.transaction((transaction) => transaction.listTurns("session-1")).length,
    1
  );

  agent.missingNativeSessionIds.add("session-1");
  await message("delete-list", "/sessions");
  assert.equal(channel.sent.at(-1)?.text, "暂无 Session");
  assert.equal(
    store.transaction((transaction) => transaction.getSession("session-1")),
    undefined
  );
  assert.equal(
    (store.database.prepare("SELECT COUNT(*) AS count FROM turns").get() as {
      count: number;
    }).count,
    0
  );
  assert.equal(
    (store.database.prepare(`
      SELECT session_id AS sessionId FROM conversation_bindings
    `).get() as { sessionId: string | null }).sessionId,
    null
  );
  assert.equal(restarts, 1);

  await message("delete-use", "/use 1");
  assert.match(channel.sent.at(-1)?.text ?? "", /序号超出范围/u);
  await message("delete-message", "还能继续吗");
  assert.equal(
    channel.sent.at(-1)?.text,
    "当前未绑定任何Session，请先使用 /sessions，再使用 /use 激活一个会话。"
  );
  store.close();
});

test("explicit approval deny cancels only the current Turn and leaves an empty queue writable", async () => {
  const { store, channel, agent, application, message } = await createRecoveryFixture({
    unknownRecoveryWindowMs: 100,
    unknownRecoveryPollMs: 5
  });
  await message("deny-new", "/new codex agentlink");
  await message("deny-input", "删除刚创建的文件");
  const turn = agent.sent[0]!;
  application.approvalRequested({
    id: "deny-request",
    nativeRequestId: "native-request-1",
    nativeItemId: "deny-item",
    sessionId: "session-1",
    turnId: turn.turnId,
    actionKind: "command",
    actionDigest: "digest-1",
    summary: "删除测试文件",
    risk: "high",
    observedAt: "2026-07-18T00:00:00.000Z"
  });
  await new Promise((resolve) => setImmediate(resolve));
  agent.onResolveApproval = (_requestId, decision) => {
    if (decision === "deny") {
      application.turnCompleted("session-1", turn.turnId, "interrupted");
    }
  };

  await message("deny-command", "/deny");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(agent.decisions, [{ requestId: "deny-request", decision: "deny" }]);
  assert.equal(
    store.transaction((transaction) => transaction.getTurn(turn.turnId))?.state,
    "CANCELLED"
  );
  assert.equal(
    store.transaction((transaction) => transaction.getSession("session-1"))?.queuePaused,
    false
  );
  assert.equal(channel.sent.at(-1)?.text, "已拒绝审批，本次任务已结束");
  assert.equal(
    channel.sent.some((output) => output.text === "任务已中断 · 删除刚创建的文件"),
    false
  );

  await message("deny-next", "拒绝后继续对话");
  assert.equal(agent.sent.length, 2);
  assert.equal(agent.sent[1]?.text, "拒绝后继续对话");
  assert.equal(
    store.transaction((transaction) => transaction.listTurns("session-1").at(-1))?.state,
    "RUNNING"
  );
  store.close();
});

test("explicit approval cancel leaves an empty queue writable without a duplicate message", async () => {
  const { store, channel, agent, application, message } = await createRecoveryFixture({
    unknownRecoveryWindowMs: 100,
    unknownRecoveryPollMs: 5
  });
  await message("cancel-new", "/new codex agentlink");
  await message("cancel-input", "执行待取消操作");
  const turn = agent.sent[0]!;
  application.approvalRequested({
    id: "cancel-request",
    nativeRequestId: "native-request-1",
    nativeItemId: "cancel-item",
    sessionId: "session-1",
    turnId: turn.turnId,
    actionKind: "command",
    actionDigest: "digest-1",
    summary: "执行待取消操作",
    risk: "high",
    observedAt: "2026-07-18T00:00:00.000Z"
  });
  await new Promise((resolve) => setImmediate(resolve));
  agent.onResolveApproval = (_requestId, decision) => {
    if (decision === "cancel") {
      application.turnCompleted("session-1", turn.turnId, "interrupted");
    }
  };

  await message("cancel-command", "/cancel");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    store.transaction((transaction) => transaction.getTurn(turn.turnId))?.state,
    "CANCELLED"
  );
  assert.equal(
    store.transaction((transaction) => transaction.getSession("session-1"))?.queuePaused,
    false
  );
  assert.equal(channel.sent.at(-1)?.text, "已停止审批中的任务");
  assert.equal(
    channel.sent.some((output) => output.text === "任务已中断 · 执行待取消操作"),
    false
  );

  await message("cancel-next", "停止后输入");
  assert.equal(agent.sent.length, 2);
  assert.equal(
    store.transaction((transaction) => transaction.listTurns("session-1").at(-1))?.state,
    "RUNNING"
  );
  store.close();
});

test("explicit approval cancel pauses a real queued Turn", async () => {
  const { store, channel, agent, application, message } = await createRecoveryFixture({
    unknownRecoveryWindowMs: 100,
    unknownRecoveryPollMs: 5
  });
  await message("cancel-queued-new", "/new codex agentlink");
  await message("cancel-queued-input", "执行待取消操作");
  const turn = agent.sent[0]!;
  application.approvalRequested({
    id: "cancel-queued-request",
    nativeRequestId: "native-request-1",
    nativeItemId: "cancel-queued-item",
    sessionId: "session-1",
    turnId: turn.turnId,
    actionKind: "command",
    actionDigest: "digest-1",
    summary: "执行待取消操作",
    risk: "high",
    observedAt: "2026-07-18T00:00:00.000Z"
  });
  await new Promise((resolve) => setImmediate(resolve));
  await message("cancel-queued-next", "等待执行的任务");
  agent.onResolveApproval = (_requestId, decision) => {
    if (decision === "cancel") {
      application.turnCompleted("session-1", turn.turnId, "interrupted");
    }
  };

  await message("cancel-queued-command", "/cancel");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(channel.sent.at(-1)?.text, "已停止审批中的任务，队列已暂停");
  assert.equal(
    store.transaction((transaction) => transaction.getSession("session-1"))?.queuePaused,
    true
  );
  assert.equal(
    store.transaction((transaction) => transaction.listTurns("session-1").at(-1))?.state,
    "PAUSED"
  );
  store.close();
});

test("Session short IDs stay at six characters unless collision requires extension", () => {
  const digests: Readonly<Record<string, string>> = {
    "session-a": "abcdef1aaaaaaaaa",
    "session-b": "abcdef2bbbbbbbbb",
    "session-c": "123456cccccccccc"
  };
  assert.deepEqual(
    sessionShortIds(Object.keys(digests), (id) => digests[id]!),
    {
      "session-a": "s-abcdef1",
      "session-b": "s-abcdef2",
      "session-c": "s-123456"
    }
  );
});

test("mobile import uses a scoped list snapshot and persists no synthetic historical Turns", async () => {
  const { store, channel, agent, application, message } = await createRecoveryFixture({
    unknownRecoveryWindowMs: 100,
    unknownRecoveryPollMs: 5
  });
  agent.externalSessions = [{
    nativeSessionId: "thread-existing",
    displayName: "修复既有登录流程",
    lastActivityAt: "2026-07-17T21:00:00.000Z",
    archived: false
  }];

  await message("projects", "/projects");
  await message("imports", "/imports 1");
  assert.match(channel.sent.at(-1)?.text ?? "", /1\. 修复既有登录流程 · 3h ago/u);
  assert.doesNotMatch(channel.sent.at(-1)?.text ?? "", /thread-existing/u);

  await application.handleChannelMessage({
    eventId: "event-other-import",
    accountId: "account-1",
    senderId: "owner-1",
    conversationId: "conversation-2",
    messageId: "other-import",
    text: "/import 1",
    receivedAt: "2026-07-18T00:00:00.000Z"
  });
  assert.equal(
    channel.sent.at(-1)?.text,
    "请求失败：请先使用 /imports <项目> 查看可导入Session"
  );

  await message("import", "/import 1");
  assert.match(channel.sent.at(-1)?.text ?? "", /已导入并绑定：修复既有登录流程/u);
  const imported = store.transaction((transaction) => transaction.getSession("session-1"));
  assert.equal(imported?.nativeSessionId, "thread-existing");
  assert.equal(imported?.state, "OPEN");
  assert.deepEqual(store.transaction((transaction) => transaction.listTurns("session-1")), []);

  await message("imports-again", "/imports agentlink");
  assert.equal(channel.sent.at(-1)?.text, "该项目暂无可导入的既有会话");
  store.close();
});

test("mobile import refuses a changed discovery snapshot instead of retargeting its number", async () => {
  const { store, channel, agent, message } = await createRecoveryFixture({
    unknownRecoveryWindowMs: 100,
    unknownRecoveryPollMs: 5
  });
  agent.externalSessions = [{
    nativeSessionId: "thread-a",
    displayName: "会话A",
    lastActivityAt: "2026-07-17T23:00:00.000Z",
    archived: false
  }];
  await message("imports", "/imports agentlink");
  agent.externalSessions = [{
    nativeSessionId: "thread-b",
    displayName: "会话B",
    lastActivityAt: "2026-07-17T23:30:00.000Z",
    archived: false
  }];
  await message("import-stale", "/import 1");
  assert.equal(
    channel.sent.at(-1)?.text,
    "请求失败：可导入Session列表已变化，请重新使用 /imports"
  );
  assert.equal(
    (store.database.prepare("SELECT COUNT(*) AS count FROM agent_sessions").get() as {
      count: number;
    }).count,
    0
  );
  store.close();
});

test("local CLI discovery and import use a separate endpoint-scoped snapshot", async () => {
  const { store, agent, application } = await createRecoveryFixture({
    unknownRecoveryWindowMs: 100,
    unknownRecoveryPollMs: 5
  });
  agent.externalSessions = [{
    nativeSessionId: "thread-local",
    displayName: "本地导入候选",
    lastActivityAt: "2026-07-17T23:00:00.000Z",
    archived: false
  }];
  assert.deepEqual(await application.handleLocalEvent({
    endpointId: "local-cli",
    kind: "session_discover",
    project: "agentlink"
  }), [{
    number: 1,
    displayName: "本地导入候选",
    relativeTime: "1h ago",
    archived: false
  }]);
  await assert.rejects(
    application.handleLocalEvent({
      endpointId: "other-local-cli",
      kind: "session_import",
      project: "agentlink",
      reference: "1"
    }),
    /先执行session discover/u
  );
  const imported = await application.handleLocalEvent({
    endpointId: "local-cli",
    kind: "session_import",
    project: "agentlink",
    reference: "1"
  }) as Record<string, unknown>;
  assert.equal(imported["displayName"], "本地导入候选");
  assert.equal(
    store.transaction((transaction) => transaction.getSession("session-1"))?.nativeSessionId,
    "thread-local"
  );
  store.close();
});

test("Grok external Session discovery is rejected without scanning or creating a snapshot", async () => {
  const { store, agent, channel, application, message } = await createRecoveryFixture({
    unknownRecoveryWindowMs: 100,
    unknownRecoveryPollMs: 5,
    allowedAgents: ["grok"],
    defaultAgent: "grok"
  });
  agent.externalSessions = [{
    nativeSessionId: "native-grok-existing",
    displayName: "不应被发现的Grok会话",
    lastActivityAt: "2026-07-17T23:00:00.000Z",
    archived: false
  }];

  await message("grok-imports", "/imports agentlink");
  assert.equal(
    channel.sent.at(-1)?.text,
    "请求失败：当前Grok版本不支持安全导入既有会话。" +
      "请使用 /new grok <项目> 创建新会话。"
  );
  await message("grok-import", "/import 1");
  assert.equal(
    channel.sent.at(-1)?.text,
    "请求失败：请先使用 /imports <项目> 查看可导入Session"
  );
  await assert.rejects(
    application.handleLocalEvent({
      endpointId: "local-cli",
      kind: "session_discover",
      project: "agentlink"
    }),
    /当前Grok版本不支持安全导入既有会话/u
  );
  assert.deepEqual(agent.externalDiscoveryProjects, []);
  assert.equal(
    (store.database.prepare("SELECT COUNT(*) AS count FROM agent_sessions").get() as {
      count: number;
    }).count,
    0
  );
  store.close();
});

test("mobile delete requires bound confirmation and clears native, local and conversation state", async () => {
  const { store, agent, channel, message } = await createRecoveryFixture({
    unknownRecoveryWindowMs: 100,
    unknownRecoveryPollMs: 5
  });
  await message("delete-create", "/new agentlink");
  const created = channel.sent.at(-1)?.text ?? "";
  const displayId = created.match(/（([^（）]+)）$/u)?.[1];
  assert.ok(displayId);

  await message("delete-request", `/delete ${displayId}`);
  assert.match(channel.sent.at(-1)?.text ?? "", /即将永久删除/u);
  assert.deepEqual(agent.deleted, []);

  await message("delete-confirm-wrong", "/delete confirm wrong");
  assert.equal(
    channel.sent.at(-1)?.text,
    "请求失败：删除确认与原请求不匹配"
  );
  await message("delete-confirm", "/delete confirm");
  assert.match(channel.sent.at(-1)?.text ?? "", /已永久删除/u);
  assert.deepEqual(agent.deleted, ["session-1"]);
  assert.equal(
    (store.database.prepare("SELECT COUNT(*) AS count FROM agent_sessions").get() as {
      count: number;
    }).count,
    0
  );
  assert.equal(
    (store.database.prepare(`
      SELECT session_id AS sessionId FROM conversation_bindings LIMIT 1
    `).get() as { sessionId: string | null }).sessionId,
    null
  );

  await message("delete-input-after", "继续");
  assert.equal(
    channel.sent.at(-1)?.text,
    "当前未绑定任何Session，请先使用 /sessions，再使用 /use 激活一个会话。"
  );
  store.close();
});

test("Grok delete coordinates Runtime replacement and rebinds idle surviving Sessions", async () => {
  const observedStates: string[][] = [];
  let storeRef: SqliteStateStore | undefined;
  const fixture = await createRecoveryFixture({
    unknownRecoveryWindowMs: 100,
    unknownRecoveryPollMs: 5,
    allowedAgents: ["grok"],
    defaultAgent: "grok",
    deleteNativeSession: async () => {
      observedStates.push((storeRef!.database.prepare(`
        SELECT state FROM agent_sessions ORDER BY id
      `).all() as { state: string }[]).map((row) => row.state));
    }
  });
  storeRef = fixture.store;
  await fixture.message("grok-delete-create-1", "/new agentlink");
  await fixture.message("grok-delete-create-2", "/new agentlink");

  await fixture.application.handleLocalEvent({
    endpointId: "local-cli",
    kind: "session_delete",
    sessionId: "session-1"
  });
  assert.deepEqual(observedStates, [["UNKNOWN", "UNKNOWN"]]);
  assert.equal(
    fixture.store.transaction((transaction) => transaction.getSession("session-1")),
    undefined
  );
  const survivor = fixture.store.transaction((transaction) =>
    transaction.getSession("session-2")
  );
  assert.equal(survivor?.state, "OPEN");
  assert.equal(survivor?.runtimeState, "ALIVE");
  fixture.store.close();
});

test("Project removal refuses any remaining Session instead of closing it implicitly", async () => {
  const { store, application, message } = await createRecoveryFixture({
    unknownRecoveryWindowMs: 100,
    unknownRecoveryPollMs: 5
  });
  await message("project-remove-create", "/new agentlink");
  await assert.rejects(
    application.handleLocalEvent({
      endpointId: "local-cli",
      kind: "project_remove",
      project: "agentlink"
    }),
    /Project仍有关联Session/u
  );
  assert.equal(
    store.transaction((transaction) => transaction.getSession("session-1"))?.state,
    "OPEN"
  );
  store.close();
});

test("a CLOSED Session can be reopened directly with its six-character /use reference", async () => {
  const root = await mkdtemp("/tmp/agentlink-closed-use-");
  const store = new SqliteStateStore(
    join(root, "state.sqlite3"),
    join(process.cwd(), "migrations")
  );
  const clock = new FakeClock();
  const ids = new FakeIdGenerator();
  const control = new ControlRepository(store.database);
  const projects = new ProjectRepository(store.database);
  const registry = new ProjectRegistry();
  const project = await registry.register({
    id: "project-1",
    slug: "agentlink",
    path: root,
    allowedAgents: ["codex"],
    defaultAgent: "codex"
  });
  projects.put({
    id: project.id,
    slug: project.slug,
    canonicalPath: project.canonicalPath,
    allowedAgents: project.allowedAgents,
    defaultAgent: project.defaultAgent,
    enabled: true,
    createdAt: clock.now()
  });
  control.putChannelAccount(
    "account-1",
    "wechat-token",
    [{ senderId: "owner-1", gatewayUserId: "user-1" }],
    clock.now()
  );
  const channel = new FakeChannel();
  const agent = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  const diagnostics: Error[] = [];
  const application = new GatewayApplication(
    store,
    control,
    projects,
    registry,
    channel,
    agent,
    clock,
    ids,
    {
      accountId: "account-1",
      identities: [{
        accountId: "account-1",
        senderId: "owner-1",
        gatewayUserId: "user-1"
      }],
      approvalLeaseMs: 300_000,
      queueLimit: 32,
      publishLocal: () => undefined,
      onDiagnostic: (_kind, error) => diagnostics.push(error)
    }
  );
  const message = (messageId: string, text: string) => application.handleChannelMessage({
    eventId: `event-${messageId}`,
    accountId: "account-1",
    senderId: "owner-1",
    conversationId: "conversation-1",
    messageId,
    text,
    receivedAt: clock.now()
  });

  await message("create", "/new agentlink");
  store.transaction((transaction) => transaction.putTurn({
    id: "turn-history",
    sessionId: "session-1",
    state: "COMPLETED",
    inputSequence: 1,
    queueSequence: 1,
    sourceEndpointId: "owner-1",
    text: "historical turn",
    createdAt: clock.now(),
    updatedAt: clock.now()
  }));
  await message("close", "/close");
  assert.equal(
    store.transaction((transaction) => transaction.getSession("session-1"))?.state,
    "CLOSED"
  );

  await message("reopen", `/use ${sessionShortId("session-1")}`);

  assert.match(channel.sent.at(-1)?.text ?? "", /已恢复并切换/u);
  assert.equal(
    store.transaction((transaction) => transaction.getSession("session-1"))?.state,
    "OPEN"
  );
  assert.deepEqual(agent.closed, ["session-1"]);
  assert.deepEqual(diagnostics, []);
  store.close();
});

test("UNKNOWN Session polling blocks input without creating a Turn and notifies on recovery", async () => {
  const { store, channel, agent, diagnostics, message } = await createRecoveryFixture({
    unknownRecoveryWindowMs: 100,
    unknownRecoveryPollMs: 5
  });
  await message("create", "/new agentlink");
  store.reconcileStartup("2026-07-18T00:01:00.000Z");
  await message("sessions", "/sessions");
  let attempts = 0;
  agent.resume = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporarily unavailable");
    return { runtimeId: "runtime-recovered", reconciledTurns: [] };
  };

  await message("use", "/use 1");
  assert.equal(
    channel.sent.at(-1)?.text,
    "Session状态暂无法核实，AgentLink将在5min内自动重试。\n期间请等待或使用其他Session。"
  );
  await message("blocked", "这条消息不能排队");
  assert.equal(
    channel.sent.at(-1)?.text,
    "Session正在自动核实，本条消息未提交。请等待恢复提示后重发。"
  );
  assert.equal(agent.sent.length, 0);
  assert.equal(
    store.transaction((transaction) => transaction.listTurns("session-1")).length,
    0
  );
  await message("blocked-status", "/status");
  assert.equal(
    channel.sent.at(-1)?.text,
    "Session状态暂无法核实，请等待或使用其他Session。"
  );

  await waitUntil(() =>
    channel.sent.some((output) => output.text === "Session状态已恢复，可以继续对话。")
  );
  assert.equal(
    store.transaction((transaction) => transaction.getSession("session-1"))?.queuePaused,
    false
  );
  const repliesBeforeInput = channel.sent.length;
  await message("after-recovery", "恢复后直接执行");
  assert.equal(agent.sent.length, 1);
  assert.equal(channel.sent.length, repliesBeforeInput);
  assert.deepEqual(diagnostics, []);
  store.close();
});

test("first input to the active UNKNOWN Session resumes it and submits that input", async () => {
  const { store, channel, agent, diagnostics, message } = await createRecoveryFixture({
    unknownRecoveryWindowMs: 100,
    unknownRecoveryPollMs: 5
  });
  await message("create", "/new agentlink");
  store.reconcileStartup("2026-07-18T00:01:00.000Z");

  const repliesBeforeInput = channel.sent.length;
  await message("first-input", "无需先use的首条消息");

  assert.equal(agent.sent.length, 1);
  assert.equal(agent.sent[0]?.text, "无需先use的首条消息");
  assert.equal(channel.sent.length, repliesBeforeInput);
  assert.equal(store.transaction((transaction) => transaction.getSession("session-1"))?.state, "OPEN");
  assert.deepEqual(diagnostics, []);
  store.close();
});

test("UNKNOWN Session without a native ID is reported as unrecoverable and never polled", async () => {
  const { store, channel, agent, message } = await createRecoveryFixture({
    unknownRecoveryWindowMs: 30,
    unknownRecoveryPollMs: 5
  });
  await message("missing-create", "/new agentlink");
  store.transaction((transaction) => {
    const session = transaction.getSession("session-1")!;
    const { nativeSessionId: _nativeSessionId, runtimeId: _runtimeId, ...withoutNative } = session;
    transaction.putSession({
      ...withoutNative,
      state: "UNKNOWN",
      runtimeState: "UNKNOWN",
      queuePaused: true
    });
  });

  await message("missing-sessions", "/sessions");
  assert.match(channel.sent.at(-1)?.text ?? "", /UNKNOWN（缺少恢复标识）/u);
  await message("missing-input", "不应发送");
  assert.equal(
    channel.sent.at(-1)?.text,
    "Session缺少原生恢复标识，本条消息未提交。"
  );
  assert.equal(agent.sent.length, 0);
  await message("missing-use", "/use 1");
  assert.equal(
    channel.sent.at(-1)?.text,
    "请求失败：该Session缺少原生恢复标识，无法恢复"
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(
    channel.sent.some((output) => output.text.includes("AgentLink将在5min内自动重试")),
    false
  );
  store.close();
});

test("definite Agent authentication failure is actionable and leaves no Session residue", async () => {
  const { store, channel, agent, message } = await createRecoveryFixture({
    unknownRecoveryWindowMs: 30,
    unknownRecoveryPollMs: 5
  });
  agent.create = async () => {
    throw new AgentAuthenticationRequiredError("Grok", "grok login");
  };

  await message("auth-create", "/new agentlink");

  assert.equal(
    channel.sent.at(-1)?.text,
    "请求失败：Grok认证已失效，请在本机执行 grok login 后重试"
  );
  assert.equal(
    store.transaction((transaction) => transaction.getSession("session-1")),
    undefined
  );
  store.close();
});

test("UNKNOWN Session polling times out once and remains non-writable", async () => {
  const { store, channel, agent, diagnostics, message } = await createRecoveryFixture({
    unknownRecoveryWindowMs: 30,
    unknownRecoveryPollMs: 5
  });
  await message("create", "/new agentlink");
  store.reconcileStartup("2026-07-18T00:01:00.000Z");
  await message("sessions", "/sessions");
  agent.resume = async () => { throw new Error("still unavailable"); };

  await message("use", "/use 1");
  await waitUntil(() =>
    channel.sent.some((output) =>
      output.text === "当前仍无法核实该Session状态。\n请稍后再试或切换其他Session。"
    )
  );
  await message("blocked", "超时后也不能排队");
  assert.equal(
    channel.sent.at(-1)?.text,
    "Session正在自动核实，本条消息未提交。请等待恢复提示后重发。"
  );
  assert.equal(agent.sent.length, 0);
  assert.equal(
    store.transaction((transaction) => transaction.listTurns("session-1")).length,
    0
  );
  await waitUntil(() =>
    channel.sent.filter((output) =>
      output.text === "当前仍无法核实该Session状态。\n请稍后再试或切换其他Session。"
    ).length === 2
  );
  assert.equal(
    channel.sent.filter((output) =>
      output.text === "当前仍无法核实该Session状态。\n请稍后再试或切换其他Session。"
    ).length,
    2
  );
  assert.ok(diagnostics.includes("session_recovery_retry_failed"));
  store.close();
});

test("recovered UNKNOWN Session does not interrupt a conversation that switched away", async () => {
  const { store, channel, agent, message } = await createRecoveryFixture({
    unknownRecoveryWindowMs: 100,
    unknownRecoveryPollMs: 5
  });
  await message("create-1", "/new agentlink");
  store.reconcileStartup("2026-07-18T00:01:00.000Z");
  await message("sessions", "/sessions");
  let attempts = 0;
  let resumeStarted = false;
  let releaseResume!: () => void;
  const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
  agent.resume = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporarily unavailable");
    resumeStarted = true;
    await resumeGate;
    return { runtimeId: "runtime-recovered", reconciledTurns: [] };
  };
  await message("use", "/use 1");
  await waitUntil(() => resumeStarted);
  await message("create-2", "/new agentlink");
  releaseResume();
  await waitUntil(() =>
    store.transaction((transaction) => transaction.getSession("session-1"))?.state === "OPEN"
  );
  assert.equal(
    channel.sent.filter((output) => output.text === "Session状态已恢复，可以继续对话。").length,
    0
  );
  assert.match(channel.sent.at(-1)?.text ?? "", /已创建并绑定：agentlink · 新会话/u);
  store.close();
});

test("/use reports verified running work and keeps stop available", async () => {
  const { store, channel, agent, message } = await createRecoveryFixture({
    unknownRecoveryWindowMs: 100,
    unknownRecoveryPollMs: 5
  });
  await message("create", "/new agentlink");
  await message("work", "仍在执行的任务");
  const running = store.transaction((transaction) =>
    transaction.listTurns("session-1")[0]
  )!;
  store.reconcileStartup("2026-07-18T00:01:00.000Z");
  agent.resume = async () => ({
    runtimeId: "runtime-recovered",
    reconciledTurns: [{ turnId: running.id, state: "RUNNING" }]
  });
  await message("sessions", "/sessions");
  await message("use", "/use 1");
  assert.equal(
    channel.sent.at(-1)?.text,
    "已切换，Agent仍在执行：仍在执行的任务\n可等待完成或 /stop"
  );
  await message("stop", "/stop");
  assert.equal(channel.sent.at(-1)?.text, "已停止当前任务");
  assert.equal(agent.cancelled.length, 1);
  assert.equal(
    store.transaction((transaction) => transaction.getSession("session-1"))?.queuePaused,
    false
  );
  store.close();
});

test("/stop suppresses late interrupted Agent text after local cancellation", async () => {
  const { store, channel, application, message } = await createRecoveryFixture({
    unknownRecoveryWindowMs: 100,
    unknownRecoveryPollMs: 5
  });
  await message("create", "/new agentlink");
  await message("work", "执行30秒等待");
  const running = store.transaction((transaction) =>
    transaction.listTurns("session-1")[0]
  )!;
  await message("stop", "/stop");
  const repliesAfterStop = channel.sent.length;
  assert.equal(channel.sent.at(-1)?.text, "已停止当前任务");
  assert.equal(
    store.transaction((transaction) => transaction.getSession("session-1"))?.queuePaused,
    false
  );

  application.turnCompleted(
    "session-1",
    running.id,
    "interrupted",
    "开始执行30秒等待"
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(channel.sent.length, repliesAfterStop);
  store.close();
});

test("external interruption ignores buffered partial text and sends an explicit status", async () => {
  const { store, channel, application, message } = await createRecoveryFixture({
    unknownRecoveryWindowMs: 100,
    unknownRecoveryPollMs: 5
  });
  await message("create", "/new agentlink");
  await message("work", "外部中断任务");
  const running = store.transaction((transaction) =>
    transaction.listTurns("session-1")[0]
  )!;
  application.turnCompleted(
    "session-1",
    running.id,
    "interrupted",
    "这只是尚未完成的中间文本"
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(channel.sent.at(-1)?.text, "任务已中断 · 外部中断任务");
  assert.equal(
    store.transaction((transaction) => transaction.getTurn(running.id))?.state,
    "CANCELLED"
  );
  store.close();
});

test("failed Turn sends the Adapter's actionable final response", async () => {
  const { store, channel, application, message } = await createRecoveryFixture({
    unknownRecoveryWindowMs: 100,
    unknownRecoveryPollMs: 5
  });
  await message("create", "/new agentlink");
  await message("work", "使用Claude继续任务");
  const running = store.transaction((transaction) =>
    transaction.listTurns("session-1")[0]
  )!;

  application.turnCompleted(
    "session-1",
    running.id,
    "failed",
    "Claude Code认证已失效，请在本机执行 claude 并在对话框中执行 /login 后重试"
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    channel.sent.at(-1)?.text,
    "Claude Code认证已失效，请在本机执行 claude 并在对话框中执行 /login 后重试"
  );
  assert.equal(
    store.transaction((transaction) => transaction.getTurn(running.id))?.state,
    "FAILED"
  );
  store.close();
});

test("completed Turn sends the Agent's final response without a lifecycle prefix", async () => {
  const { store, channel, application, message } = await createRecoveryFixture({
    unknownRecoveryWindowMs: 100,
    unknownRecoveryPollMs: 5
  });
  await message("create", "/new agentlink");
  await message("work", "只回复两个字母：ok");
  const running = store.transaction((transaction) =>
    transaction.listTurns("session-1")[0]
  )!;

  application.turnCompleted("session-1", running.id, "completed", "ok");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(channel.sent.at(-1)?.text, "ok");
  assert.equal(
    store.transaction((transaction) => transaction.getTurn(running.id))?.finalResponse,
    "ok"
  );
  store.close();
});

test("/use preserves historical paused work and points to /queue", async () => {
  const { store, channel, message } = await createRecoveryFixture({
    unknownRecoveryWindowMs: 100,
    unknownRecoveryPollMs: 5
  });
  await message("create", "/new agentlink");
  store.transaction((transaction) => {
    const session = transaction.getSession("session-1")!;
    transaction.putSession({ ...session, queuePaused: true });
  });
  await message("paused", "历史暂停任务");
  await message("sessions", "/sessions");
  await message("use", "/use 1");
  assert.equal(
    channel.sent.at(-1)?.text,
    "已切换，但存在1个暂停任务。\n查看：/queue"
  );
  await message("queue", "/queue");
  assert.match(channel.sent.at(-1)?.text ?? "", /1\. 暂停 · 历史暂停任务/u);
  await message("cancel", "/queue cancel");
  assert.equal(channel.sent.at(-1)?.text, "已取消：历史暂停任务");
  assert.equal(
    store.transaction((transaction) => transaction.getSession("session-1"))?.queuePaused,
    false
  );
  store.close();
});

async function waitUntil(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for recovery condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
