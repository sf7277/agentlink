import assert from "node:assert/strict";
import { test } from "node:test";
import { SharedCodexAdapter, type CodexAdapterEvents } from "../../src/agent-codex/adapter/shared-codex-adapter.js";
import { JsonlRpcClient } from "../../src/agent-codex/protocol/jsonl-rpc-client.js";
import type { AgentApprovalRequest, AgentSession } from "../../src/core/domain/model.js";
import { AgentOperationUncertainError } from "../../src/core/domain/errors.js";
import { FakeDigestService, FakeIdGenerator, openSession } from "../fakes/core-fakes.js";
import { FakeAppServerTransport } from "../fakes/fake-app-server.js";

function session(id: string): AgentSession {
  return { ...openSession(id), projectId: `project-${id}` };
}

test("shared adapter isolates two interleaved threads, Turns and approvals", async () => {
  const transport = new FakeAppServerTransport();
  const client = new JsonlRpcClient(transport);
  await client.initialize("0.1.0");
  const started: string[] = [];
  const completed: { sessionId: string; turnId: string; text?: string }[] = [];
  const approvals: AgentApprovalRequest[] = [];
  const protocolErrors: Error[] = [];
  const runtimeExits: string[][] = [];
  const names: string[] = [];
  const events: CodexAdapterEvents = {
    turnStarted: (sessionId, turnId) => started.push(`${sessionId}:${turnId}`),
    turnCompleted: (sessionId, turnId, _status, text) => completed.push({
      sessionId, turnId, ...(text === undefined ? {} : { text })
    }),
    approvalRequested: (request) => approvals.push(request),
    threadNameUpdated: (sessionId, displayName) => names.push(`${sessionId}:${displayName}`),
    runtimeExited: (sessionIds) => runtimeExits.push([...sessionIds]),
    protocolError: (error) => protocolErrors.push(error)
  };
  const adapter = new SharedCodexAdapter(
    client,
    new FakeDigestService(),
    new FakeIdGenerator(),
    events,
    { projectPath: (projectId) => `/workspace/${projectId}`, maxActiveTurns: 2 }
  );
  const [nativeA, nativeB] = await Promise.all([
    adapter.create(session("session-a")),
    adapter.create(session("session-b"))
  ]);
  assert.equal(nativeA.runtimeId, nativeB.runtimeId);
  assert.equal(adapter.threadForSession("session-a"), "thread-1");
  assert.equal(adapter.threadForSession("session-b"), "thread-2");
  transport.renameThread("thread-1", "修复移动端会话体验");
  assert.deepEqual(names, ["session-a:修复移动端会话体验"]);
  const [turnA, turnB] = await Promise.all([
    adapter.sendTurn({ sessionId: "session-a", turnId: "gateway-turn-a", text: "A" }),
    adapter.sendTurn({ sessionId: "session-b", turnId: "gateway-turn-b", text: "B" })
  ]);
  const startParams = transport.methodCalls.find((call) => call.method === "thread/start")?.params as
    Record<string, unknown>;
  const turnParams = transport.methodCalls.find((call) => call.method === "turn/start")?.params as
    Record<string, unknown>;
  assert.equal(startParams["approvalPolicy"], undefined);
  assert.equal(startParams["sandbox"], undefined);
  assert.equal(turnParams["approvalPolicy"], undefined);
  assert.deepEqual(started.sort(), ["session-a:gateway-turn-a", "session-b:gateway-turn-b"]);

  const completeCommand = `/bin/zsh -lc '${"echo safe-step ".repeat(24)}--final-marker'`;
  const commandRequestId = transport.request("item/commandExecution/requestApproval", {
    threadId: "thread-2", turnId: turnB.nativeTurnId, itemId: "item-b", command: completeCommand
  });
  const fileRequestId = transport.request("item/fileChange/requestApproval", {
    threadId: "thread-1", turnId: turnA.nativeTurnId, itemId: "item-a", reason: "write A"
  });
  const permissionsRequestId = transport.request("item/permissions/requestApproval", {
    threadId: "thread-2", turnId: turnB.nativeTurnId, itemId: "item-p", reason: "network",
    permissions: { network: { enabled: true }, fileSystem: null }
  });
  assert.deepEqual(approvals.map((item) => item.sessionId), ["session-b", "session-a", "session-b"]);
  assert.equal(new Set(approvals.map((item) => item.actionDigest)).size, 3);
  const commandApproval = approvals.find((item) => item.actionKind === "command");
  const fileApproval = approvals.find((item) => item.actionKind === "file");
  const permissionsApproval = approvals.find((item) => item.actionKind === "permissions");
  assert.ok(commandApproval);
  assert.ok(fileApproval);
  assert.ok(permissionsApproval);
  assert.equal(commandApproval.summary, `Codex请求执行命令：${completeCommand}`);
  assert.doesNotMatch(commandApproval.summary, /…/u);
  assert.equal(permissionsApproval.nativeItemId, "item-p");
  assert.deepEqual(await adapter.inspectApproval(commandApproval.id), {
    status: "pending",
    nativeRequestId: commandApproval.nativeRequestId,
    actionDigest: commandApproval.actionDigest
  });
  await adapter.resolveApproval(commandApproval.id, "deny");
  assert.deepEqual(await adapter.inspectApproval(commandApproval.id), { status: "resolved" });
  await adapter.resolveApproval(fileApproval.id, "allow_once");
  await adapter.resolveApproval(permissionsApproval.id, "allow_once");
  assert.deepEqual(
    transport.clientResponses.find((item) => item["id"] === commandRequestId)?.["result"],
    { decision: "decline" }
  );
  assert.deepEqual(
    transport.clientResponses.find((item) => item["id"] === fileRequestId)?.["result"],
    { decision: "accept" }
  );
  assert.deepEqual(
    transport.clientResponses.find((item) => item["id"] === permissionsRequestId)?.["result"],
    { permissions: { network: { enabled: true } }, scope: "turn" }
  );
  const deniedPermissionsId = transport.request("item/permissions/requestApproval", {
    threadId: "thread-2", turnId: turnB.nativeTurnId, itemId: "item-p-deny",
    permissions: { network: { enabled: true }, fileSystem: null }
  });
  const deniedPermissions = approvals.find((item) => item.nativeItemId === "item-p-deny");
  assert.ok(deniedPermissions);
  await adapter.resolveApproval(deniedPermissions.id, "deny");
  assert.deepEqual(
    transport.clientResponses.find((item) => item["id"] === deniedPermissionsId)?.["result"],
    { permissions: {}, scope: "turn" }
  );
  transport.request("item/permissions/requestApproval", {
    threadId: "thread-2", turnId: turnB.nativeTurnId, itemId: "item-p-cancel",
    permissions: { network: { enabled: true }, fileSystem: null }
  });
  const cancelledPermissions = approvals.find((item) => item.nativeItemId === "item-p-cancel");
  assert.ok(cancelledPermissions);
  await adapter.resolveApproval(cancelledPermissions.id, "cancel");
  assert.ok(transport.methodCalls.some((item) =>
    item.method === "turn/interrupt" &&
    (item.params as Record<string, unknown>)["turnId"] === turnB.nativeTurnId
  ));
  const externallyResolvedId = transport.request("item/fileChange/requestApproval", {
    threadId: "thread-1", turnId: turnA.nativeTurnId, itemId: "item-external"
  });
  const externallyResolved = approvals.find((item) => item.nativeItemId === "item-external");
  assert.ok(externallyResolved);
  transport.notify("serverRequest/resolved", {
    threadId: "thread-1",
    requestId: externallyResolvedId
  });
  assert.deepEqual(await adapter.inspectApproval(externallyResolved.id), { status: "resolved" });

  await adapter.steer({ sessionId: "session-a", turnId: "gateway-turn-a", text: "constraint" });
  await adapter.cancel("session-b", "gateway-turn-b");
  transport.completeTurn("thread-2", turnB.nativeTurnId, "B done", "interrupted");
  transport.completeTurn("thread-1", turnA.nativeTurnId, "A done");
  assert.deepEqual(completed, [
    { sessionId: "session-b", turnId: "gateway-turn-b", text: "B done" },
    { sessionId: "session-a", turnId: "gateway-turn-a", text: "A done" }
  ]);
  await adapter.close(session("session-a"));
  const nextB = await adapter.sendTurn({
    sessionId: "session-b", turnId: "gateway-turn-b2", text: "B2"
  });
  transport.completeTurn("thread-2", nextB.nativeTurnId, "B2 done");
  await transport.close();
  assert.deepEqual(runtimeExits, [["session-b"]]);
  assert.deepEqual(protocolErrors, []);
});

test("unroutable approval is rejected instead of guessed from recent activity", async () => {
  const transport = new FakeAppServerTransport();
  const client = new JsonlRpcClient(transport);
  await client.initialize("0.1.0");
  const errors: Error[] = [];
  const adapter = new SharedCodexAdapter(
    client,
    new FakeDigestService(),
    new FakeIdGenerator(),
    {
      turnStarted: () => undefined,
      turnCompleted: () => undefined,
      approvalRequested: () => undefined,
      runtimeExited: () => undefined,
      protocolError: (error) => errors.push(error)
    },
    { projectPath: () => "/workspace" }
  );
  await adapter.create(session("session-a"));
  const requestId = transport.request("item/fileChange/requestApproval", {
    threadId: "unknown-thread", turnId: "unknown-turn", itemId: "item"
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.deepEqual(transport.clientResponses.find((item) => item["id"] === requestId)?.["error"], {
    code: -32602,
    message: "Approval request could not be routed"
  });
});

test("shared adapter resume reads native Turns and reconciles an interrupted UNKNOWN Turn", async () => {
  const transport = new FakeAppServerTransport();
  transport.seedThread("thread-existing", {
    "native-turn-existing": "interrupted"
  });
  const client = new JsonlRpcClient(transport);
  await client.initialize("0.1.0");
  const adapter = new SharedCodexAdapter(
    client,
    new FakeDigestService(),
    new FakeIdGenerator(),
    {
      turnStarted: () => undefined,
      turnCompleted: () => undefined,
      approvalRequested: () => undefined,
      runtimeExited: () => undefined,
      protocolError: (error) => { throw error; }
    },
    { projectPath: () => "/workspace" }
  );
  const resumedSession = {
    ...session("session-a"),
    nativeSessionId: "thread-existing",
    state: "UNKNOWN" as const,
    runtimeState: "EXITED" as const,
    queuePaused: true
  };
  const result = await adapter.resume(resumedSession, [{
    id: "gateway-turn-existing",
    sessionId: "session-a",
    nativeTurnId: "native-turn-existing",
    state: "UNKNOWN",
    inputSequence: 1,
    sourceEndpointId: "wechat-owner",
    text: "work",
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z"
  }]);
  assert.deepEqual(result.reconciledTurns, [{
    turnId: "gateway-turn-existing",
    state: "CANCELLED"
  }]);
  assert.equal(adapter.threadForSession("session-a"), "thread-existing");
});

test("shared adapter discovers and imports only safe threads for the exact registered cwd", async () => {
  const transport = new FakeAppServerTransport();
  transport.seedExternalThread({
    threadId: "thread-importable",
    cwd: "/workspace/project",
    name: "修复登录流程",
    updatedAt: 1_752_800_400
  });
  transport.seedExternalThread({
    threadId: "thread-archived",
    cwd: "/workspace/project",
    preview: "补充回归测试",
    archived: true,
    updatedAt: 1_752_800_000
  });
  transport.seedExternalThread({
    threadId: "thread-other-project",
    cwd: "/workspace/other"
  });
  transport.seedExternalThread({
    threadId: "thread-active",
    cwd: "/workspace/project",
    turns: { "turn-active": "inProgress" }
  });
  transport.seedExternalThread({
    threadId: "thread-ephemeral",
    cwd: "/workspace/project",
    ephemeral: true
  });
  transport.seedExternalThread({
    threadId: "thread-subagent",
    cwd: "/workspace/project",
    source: { subAgent: { thread_spawn: { parent_thread_id: "parent" } } }
  });
  const client = new JsonlRpcClient(transport);
  await client.initialize("0.1.0");
  const adapter = new SharedCodexAdapter(
    client,
    new FakeDigestService(),
    new FakeIdGenerator(),
    {
      turnStarted: () => undefined,
      turnCompleted: () => undefined,
      approvalRequested: () => undefined,
      runtimeExited: () => undefined,
      protocolError: (error) => { throw error; }
    },
    { projectPath: () => "/workspace/project" }
  );

  const candidates = await adapter.discoverExternalSessions("project-1");
  assert.deepEqual(candidates.map((candidate) => ({
    id: candidate.nativeSessionId,
    name: candidate.displayName,
    archived: candidate.archived
  })), [
    { id: "thread-importable", name: "修复登录流程", archived: false },
    { id: "thread-archived", name: "补充回归测试", archived: true }
  ]);

  const imported = await adapter.importExternalSession(
    {
      ...session("session-imported"),
      projectId: "project-1",
      nativeSessionId: "thread-importable",
      state: "CREATING",
      runtimeState: "STARTING"
    },
    candidates[0]!
  );
  assert.equal(imported.nativeSessionId, "thread-importable");
  assert.equal(imported.displayName, "修复登录流程");
  assert.equal(adapter.threadForSession("session-imported"), "thread-importable");
  const importReads = transport.methodCalls.filter((call) =>
    call.method === "thread/read" &&
    (call.params as Record<string, unknown>)["threadId"] === "thread-importable"
  );
  assert.ok(importReads.length >= 2);
  assert.ok(importReads.every((call) =>
    (call.params as Record<string, unknown>)["includeTurns"] === false
  ));
});

test("archived external import rolls native archive state back when resume fails", async () => {
  const transport = new FakeAppServerTransport();
  transport.seedExternalThread({
    threadId: "thread-archived",
    cwd: "/workspace",
    archived: true
  });
  const client = new JsonlRpcClient(transport);
  await client.initialize("0.1.0");
  const adapter = new SharedCodexAdapter(
    client,
    new FakeDigestService(),
    new FakeIdGenerator(),
    {
      turnStarted: () => undefined,
      turnCompleted: () => undefined,
      approvalRequested: () => undefined,
      runtimeExited: () => undefined,
      protocolError: (error) => { throw error; }
    },
    { projectPath: () => "/workspace" }
  );
  const candidate = (await adapter.discoverExternalSessions("project-1"))[0]!;
  transport.failNext("thread/resume");
  await assert.rejects(() => adapter.importExternalSession(
    {
      ...session("session-imported"),
      projectId: "project-1",
      nativeSessionId: "thread-archived",
      state: "CREATING",
      runtimeState: "STARTING"
    },
    candidate
  ));
  assert.deepEqual(
    transport.methodCalls.slice(-3).map((call) => call.method),
    ["thread/unarchive", "thread/resume", "thread/archive"]
  );
});

test("large external rollout creates a bounded continuation without resuming the source", async () => {
  const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "agentlink-adapter-rollout-"));
  const project = join(root, "project");
  const sessions = join(root, "sessions");
  await mkdir(project);
  await mkdir(sessions);
  const threadId = "019f7535-f85d-7f00-847b-e7a0ccb17724";
  await writeFile(join(sessions, `rollout-test-${threadId}.jsonl`), [
    JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: project } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", model_context_window: 1000 } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "问题" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "回答" } })
  ].join("\n"), { mode: 0o600 });
  const transport = new FakeAppServerTransport();
  transport.seedExternalThread({ threadId, cwd: project, preview: "大型会话" });
  const client = new JsonlRpcClient(transport);
  await client.initialize("0.1.0");
  const adapter = new SharedCodexAdapter(
    client, new FakeDigestService(), new FakeIdGenerator(),
    {
      turnStarted: () => undefined, turnCompleted: () => undefined,
      approvalRequested: () => undefined, runtimeExited: () => undefined,
      protocolError: (error) => { throw error; }
    },
    { projectPath: () => project, boundedRollout: { searchRoot: sessions, largeThresholdBytes: 1 } }
  );
  try {
    const imported = await adapter.importExternalSession(
      {
        ...session("session-imported"), projectId: "project-1", nativeSessionId: threadId,
        state: "CREATING", runtimeState: "STARTING"
      },
      { nativeSessionId: threadId, displayName: "大型会话", lastActivityAt: "2026-07-18T00:00:00Z", archived: false }
    );
    assert.notEqual(imported.nativeSessionId, threadId);
    assert.equal(imported.sourceNativeSessionId, threadId);
    assert.equal(imported.nativeLifecycleOwner, "AGENTLINK");
    assert.equal(imported.historyTruncated, true);
    assert.equal(transport.methodCalls.some((call) => call.method === "thread/resume"), false);
    assert.equal(transport.methodCalls.some((call) => call.method === "thread/inject_items"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared adapter closes a persisted thread after restart and reopens a closed thread", async () => {
  const transport = new FakeAppServerTransport();
  transport.seedThread("thread-existing", {});
  const client = new JsonlRpcClient(transport);
  await client.initialize("0.1.0");
  const adapter = new SharedCodexAdapter(
    client,
    new FakeDigestService(),
    new FakeIdGenerator(),
    {
      turnStarted: () => undefined,
      turnCompleted: () => undefined,
      approvalRequested: () => undefined,
      runtimeExited: () => undefined,
      protocolError: (error) => { throw error; }
    },
    { projectPath: () => "/workspace" }
  );
  const persisted = {
    ...session("session-a"),
    nativeSessionId: "thread-existing",
    state: "UNKNOWN" as const,
    runtimeState: "UNKNOWN" as const,
    queuePaused: true
  };

  await adapter.close(persisted);
  assert.equal(
    transport.methodCalls.filter((call) => call.method === "thread/archive").length,
    1
  );
  const closed = { ...persisted, state: "CLOSED" as const };
  await adapter.resume(closed, [], { reopenClosed: true });
  assert.deepEqual(
    transport.methodCalls
      .filter((call) => call.method.startsWith("thread/"))
      .slice(-3)
      .map((call) => call.method),
    ["thread/unarchive", "thread/resume", "thread/read"]
  );
  assert.equal(adapter.threadForSession("session-a"), "thread-existing");
  await transport.close();
});

test("shared adapter deletes a new empty thread when native archive has no rollout", async () => {
  const transport = new FakeAppServerTransport();
  const client = new JsonlRpcClient(transport);
  await client.initialize("0.1.0");
  const adapter = new SharedCodexAdapter(
    client,
    new FakeDigestService(),
    new FakeIdGenerator(),
    {
      turnStarted: () => undefined,
      turnCompleted: () => undefined,
      approvalRequested: () => undefined,
      runtimeExited: () => undefined,
      protocolError: (error) => { throw error; }
    },
    { projectPath: () => "/workspace" }
  );
  const created = await adapter.create(session("session-empty"));
  const empty = { ...session("session-empty"), nativeSessionId: created.nativeSessionId };
  transport.failNext(
    "thread/archive",
    `no rollout found for thread id ${created.nativeSessionId}`,
    -32600
  );

  assert.equal(await adapter.close(empty), "empty_session_deleted");
  assert.equal(adapter.threadForSession("session-empty"), undefined);
  assert.deepEqual(
    transport.methodCalls
      .filter((call) => call.method.startsWith("thread/"))
      .slice(-2)
      .map((call) => call.method),
    ["thread/archive", "thread/delete"]
  );
  await transport.close();
});

test("shared adapter detach forgets only local mapping while delete calls native thread/delete", async () => {
  const transport = new FakeAppServerTransport();
  transport.seedThread("thread-external", {});
  transport.seedThread("thread-owned", {});
  const client = new JsonlRpcClient(transport);
  await client.initialize("0.1.0");
  const adapter = new SharedCodexAdapter(
    client,
    new FakeDigestService(),
    new FakeIdGenerator(),
    {
      turnStarted: () => undefined,
      turnCompleted: () => undefined,
      approvalRequested: () => undefined,
      runtimeExited: () => undefined,
      protocolError: (error) => { throw error; }
    },
    { projectPath: () => "/workspace" }
  );
  const external = { ...session("external"), nativeSessionId: "thread-external" };
  transport.hideThreadFromList("thread-external");
  assert.deepEqual(
    await adapter.findMissingNativeSessions([
      external,
      { ...session("missing"), nativeSessionId: "thread-missing" }
    ]),
    ["missing"]
  );
  assert.equal(
    transport.methodCalls.some((call) =>
      call.method === "thread/read" &&
      (call.params as { threadId?: string }).threadId === "thread-external"
    ),
    true
  );
  await adapter.resume(external, []);
  await adapter.detach(external);
  assert.equal(adapter.threadForSession("external"), undefined);
  assert.equal(transport.methodCalls.some((call) => call.method === "thread/archive"), false);
  assert.equal(transport.methodCalls.some((call) => call.method === "thread/delete"), false);

  const owned = { ...session("owned"), nativeSessionId: "thread-owned" };
  await adapter.resume(owned, []);
  await adapter.deleteNativeSession(owned);
  assert.equal(adapter.threadForSession("owned"), undefined);
  assert.equal(
    transport.methodCalls.filter((call) => call.method === "thread/delete").length,
    1
  );
  await transport.close();
});

test("closed thread resume rolls back unarchive when native resume fails", async () => {
  const transport = new FakeAppServerTransport();
  transport.seedThread("thread-existing", {});
  transport.failNext("thread/resume");
  const client = new JsonlRpcClient(transport);
  await client.initialize("0.1.0");
  const adapter = new SharedCodexAdapter(
    client,
    new FakeDigestService(),
    new FakeIdGenerator(),
    {
      turnStarted: () => undefined,
      turnCompleted: () => undefined,
      approvalRequested: () => undefined,
      runtimeExited: () => undefined,
      protocolError: () => undefined
    },
    { projectPath: () => "/workspace" }
  );
  const closed = {
    ...session("session-a"),
    nativeSessionId: "thread-existing",
    state: "CLOSED" as const,
    runtimeState: "UNKNOWN" as const,
    queuePaused: true
  };

  await assert.rejects(adapter.resume(closed, [], { reopenClosed: true }), /Injected/u);
  assert.deepEqual(
    transport.methodCalls
      .filter((call) => call.method.startsWith("thread/"))
      .map((call) => call.method),
    ["thread/unarchive", "thread/resume", "thread/archive"]
  );
  await transport.close();
});

test("closed thread resume also rolls back when post-resume verification fails", async () => {
  const transport = new FakeAppServerTransport();
  transport.seedThread("thread-existing", {});
  transport.failNext("thread/read");
  const client = new JsonlRpcClient(transport);
  await client.initialize("0.1.0");
  const adapter = new SharedCodexAdapter(
    client,
    new FakeDigestService(),
    new FakeIdGenerator(),
    {
      turnStarted: () => undefined,
      turnCompleted: () => undefined,
      approvalRequested: () => undefined,
      runtimeExited: () => undefined,
      protocolError: () => undefined
    },
    { projectPath: () => "/workspace" }
  );
  const closed = {
    ...session("session-a"),
    nativeSessionId: "thread-existing",
    state: "CLOSED" as const,
    runtimeState: "UNKNOWN" as const,
    queuePaused: true
  };

  await assert.rejects(adapter.resume(closed, [], { reopenClosed: true }), /Injected/u);
  assert.deepEqual(
    transport.methodCalls
      .filter((call) => call.method.startsWith("thread/"))
      .map((call) => call.method),
    ["thread/unarchive", "thread/resume", "thread/read", "thread/archive"]
  );
  assert.equal(adapter.threadForSession("session-a"), undefined);
  await transport.close();
});

test("closed thread resume reports uncertainty when archive rollback fails", async () => {
  const transport = new FakeAppServerTransport();
  transport.seedThread("thread-existing", {});
  transport.failNext("thread/resume");
  transport.failNext("thread/archive");
  const client = new JsonlRpcClient(transport);
  await client.initialize("0.1.0");
  const adapter = new SharedCodexAdapter(
    client,
    new FakeDigestService(),
    new FakeIdGenerator(),
    {
      turnStarted: () => undefined,
      turnCompleted: () => undefined,
      approvalRequested: () => undefined,
      runtimeExited: () => undefined,
      protocolError: () => undefined
    },
    { projectPath: () => "/workspace" }
  );
  const closed = {
    ...session("session-a"),
    nativeSessionId: "thread-existing",
    state: "CLOSED" as const,
    runtimeState: "UNKNOWN" as const,
    queuePaused: true
  };

  await assert.rejects(
    adapter.resume(closed, [], { reopenClosed: true }),
    (error: unknown) => error instanceof AgentOperationUncertainError
  );
  await transport.close();
});

test("shared adapter applies bounded FIFO capacity before writing another turn/start", async () => {
  const transport = new FakeAppServerTransport();
  const client = new JsonlRpcClient(transport);
  await client.initialize("0.1.0");
  const adapter = new SharedCodexAdapter(
    client,
    new FakeDigestService(),
    new FakeIdGenerator(),
    {
      turnStarted: () => undefined,
      turnCompleted: () => undefined,
      approvalRequested: () => undefined,
      runtimeExited: () => undefined,
      protocolError: (error) => { throw error; }
    },
    { projectPath: () => "/workspace", maxActiveTurns: 1 }
  );
  await Promise.all([
    adapter.create(session("session-a")),
    adapter.create(session("session-b")),
    adapter.create(session("session-c"))
  ]);
  const first = await adapter.sendTurn({
    sessionId: "session-a", turnId: "gateway-a", text: "A"
  });
  let secondResolved = false;
  let thirdResolved = false;
  const secondPromise = adapter.sendTurn({
    sessionId: "session-b", turnId: "gateway-b", text: "B"
  }).then((result) => {
    secondResolved = true;
    return result;
  });
  const thirdPromise = adapter.sendTurn({
    sessionId: "session-c", turnId: "gateway-c", text: "C"
  }).then((result) => {
    thirdResolved = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondResolved, false);
  assert.equal(thirdResolved, false);
  transport.completeTurn("thread-1", first.nativeTurnId, "A done");
  const second = await secondPromise;
  assert.equal(secondResolved, true);
  assert.equal(thirdResolved, false);
  transport.completeTurn("thread-2", second.nativeTurnId, "B done");
  const third = await thirdPromise;
  assert.equal(thirdResolved, true);
  transport.completeTurn("thread-3", third.nativeTurnId, "C done");
  await transport.close();
});
