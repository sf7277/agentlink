import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SharedGrokAdapter } from "../../src/agent-grok/adapter/shared-grok-adapter.js";
import { AcpRpcClient } from "../../src/agent-grok/protocol/acp-rpc-client.js";
import {
  AgentAuthenticationRequiredError
} from "../../src/core/domain/errors.js";
import { FakeDigestService, FakeIdGenerator, openSession } from "../fakes/core-fakes.js";
import { FakeAcpTransport } from "../fakes/fake-acp-server.js";

test("SharedGrokAdapter create + sendTurn completes via session/prompt events", async () => {
  const transport = new FakeAcpTransport();
  const client = new AcpRpcClient(transport, { requestTimeoutMs: 5_000 });
  await client.initialize("0.0.0-test");
  const completed: Array<{ status: string; text?: string }> = [];
  const adapter = new SharedGrokAdapter(
    client,
    new FakeDigestService(),
    new FakeIdGenerator(),
    {
      turnCompleted: (_s, _t, status, finalResponse) => {
        completed.push({ status, ...(finalResponse === undefined ? {} : { text: finalResponse }) });
      },
      approvalRequested: () => undefined,
      runtimeExited: () => undefined,
      protocolError: (error) => {
        throw error;
      }
    },
    { projectPath: () => "/tmp/project" }
  );
  const session = { ...openSession("session-1"), agentKind: "grok", state: "CREATING" as const };
  const created = await adapter.create(session);
  assert.match(created.nativeSessionId, /^gs-/u);
  assert.equal(created.runtimeId, "grok-shared");
  await adapter.sendTurn({ sessionId: "session-1", turnId: "turn-1", text: "hello" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.status, "completed");
  assert.equal(completed[0]?.text, "echo:hello");
  assert.equal(adapter.capabilities().steering, false);
  assert.equal(adapter.capabilities().approvals, true);
});

test("SharedGrokAdapter maps definite session authentication rejection", async () => {
  const transport = new FakeAcpTransport();
  transport.sessionLifecycleError = { code: -32000, message: "Authentication required" };
  const client = new AcpRpcClient(transport, { requestTimeoutMs: 5_000 });
  await client.initialize("0.0.0-test");
  const adapter = new SharedGrokAdapter(
    client,
    new FakeDigestService(),
    new FakeIdGenerator(),
    {
      turnCompleted: () => undefined,
      approvalRequested: () => undefined,
      runtimeExited: () => undefined,
      protocolError: () => undefined
    },
    { projectPath: () => "/tmp/project", grokHome: "/private/tmp/agentlink-grok-home" }
  );

  await assert.rejects(
    adapter.create({ ...openSession("auth"), agentKind: "grok", state: "CREATING" }),
    (error: unknown) =>
      error instanceof AgentAuthenticationRequiredError &&
      error.code === "agent_authentication_required" &&
      error.message ===
        "Grok认证已失效，请在本机执行 GROK_HOME='/private/tmp/agentlink-grok-home' grok login 后重试"
  );
});

test("SharedGrokAdapter maps permission allow-once and rejects steer", async () => {
  const transport = new FakeAcpTransport();
  transport.permissionMode = "request";
  const client = new AcpRpcClient(transport, { requestTimeoutMs: 5_000 });
  await client.initialize("0.0.0-test");
  const approvals: string[] = [];
  const adapter = new SharedGrokAdapter(
    client,
    new FakeDigestService(),
    new FakeIdGenerator(),
    {
      turnCompleted: () => undefined,
      approvalRequested: (request) => {
        approvals.push(request.id);
        void adapter.resolveApproval(request.id, "allow_once");
      },
      runtimeExited: () => undefined,
      protocolError: () => undefined
    },
    { projectPath: () => "/tmp/project" }
  );
  await adapter.create({ ...openSession("session-2"), agentKind: "grok", state: "CREATING" });
  await adapter.sendTurn({ sessionId: "session-2", turnId: "turn-2", text: "write" });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(approvals.length, 1);
  await assert.rejects(
    () => adapter.steer({ sessionId: "session-2", turnId: "turn-2", text: "x" }),
    /steering/u
  );
});

test("SharedGrokAdapter applies fair shared Runtime Turn capacity", async () => {
  const transport = new FakeAcpTransport();
  transport.promptDelayMs = 30;
  const client = new AcpRpcClient(transport, { requestTimeoutMs: 5_000 });
  await client.initialize("0.0.0-test");
  const adapter = new SharedGrokAdapter(
    client,
    new FakeDigestService(),
    new FakeIdGenerator(),
    {
      turnCompleted: () => undefined,
      approvalRequested: () => undefined,
      runtimeExited: () => undefined,
      protocolError: () => undefined
    },
    { projectPath: () => "/tmp/project", maxActiveTurns: 1 }
  );
  const first = { ...openSession("capacity-1"), agentKind: "grok", state: "CREATING" as const };
  const second = { ...openSession("capacity-2"), agentKind: "grok", state: "CREATING" as const };
  await adapter.create(first);
  await adapter.create(second);
  await adapter.sendTurn({
    sessionId: first.id,
    turnId: "turn-capacity-1",
    text: "first"
  });
  let secondStarted = false;
  const waiting = adapter.sendTurn({
    sessionId: second.id,
    turnId: "turn-capacity-2",
    text: "second"
  }).then(() => {
    secondStarted = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(secondStarted, false);
  assert.equal(transport.prompts.length, 1);
  await waiting;
  assert.equal(secondStarted, true);
  assert.equal(transport.prompts.length, 2);
});

test("SharedGrokAdapter forwards verified ACP session title updates", async () => {
  const transport = new FakeAcpTransport();
  const client = new AcpRpcClient(transport, { requestTimeoutMs: 5_000 });
  await client.initialize("0.0.0-test");
  const names: Array<{ sessionId: string; displayName: string }> = [];
  const adapter = new SharedGrokAdapter(
    client,
    new FakeDigestService(),
    new FakeIdGenerator(),
    {
      turnCompleted: () => undefined,
      approvalRequested: () => undefined,
      sessionNameUpdated: (sessionId, displayName) =>
        names.push({ sessionId, displayName }),
      runtimeExited: () => undefined,
      protocolError: () => undefined
    },
    { projectPath: () => "/tmp/project" }
  );
  const session = { ...openSession("named"), agentKind: "grok", state: "CREATING" as const };
  const native = await adapter.create(session);
  transport.emitSessionInfo(native.nativeSessionId, "原生Grok标题");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(names, [{
    sessionId: session.id,
    displayName: "原生Grok标题"
  }]);
});

test("RoutingAgentPort routes create by agentKind", async () => {
  const { RoutingAgentPort } = await import("../../src/composition/routing-agent-port.js");
  const { FakeAgent } = await import("../fakes/core-fakes.js");
  const codex = new FakeAgent({ steering: true, cancellation: true, approvals: true });
  const grok = new FakeAgent({ steering: false, cancellation: true, approvals: true });
  const router = new RoutingAgentPort({ codex, grok });
  await router.create({ ...openSession("s-c"), agentKind: "codex", state: "CREATING" });
  await router.create({ ...openSession("s-g"), id: "s-g", agentKind: "grok", state: "CREATING" });
  assert.equal(codex.created.length, 1);
  assert.equal(grok.created.length, 1);
  await router.sendTurn({ sessionId: "s-g", turnId: "t1", text: "hi" });
  assert.equal(grok.sent.length, 1);
  assert.equal(codex.sent.length, 0);
  assert.equal(router.capabilities("s-c").steering, true);
  assert.equal(router.capabilities("s-g").steering, false);
});

test("ACP client does not advertise host file reading", async () => {
  const transport = new FakeAcpTransport();
  const client = new AcpRpcClient(transport, { requestTimeoutMs: 5_000 });
  await client.initialize("0.0.0-test");
  const capabilities = transport.initializeParams?.["clientCapabilities"] as {
    fs?: { readTextFile?: boolean };
  };
  assert.equal(capabilities.fs?.readTextFile, false);
});

test("Grok close and delete are capability-gated and never report detach as native deletion", async () => {
  const transport = new FakeAcpTransport();
  const client = new AcpRpcClient(transport, { requestTimeoutMs: 5_000 });
  await client.initialize("0.0.0-test");
  const adapter = new SharedGrokAdapter(
    client,
    new FakeDigestService(),
    new FakeIdGenerator(),
    {
      turnCompleted: () => undefined,
      approvalRequested: () => undefined,
      runtimeExited: () => undefined,
      protocolError: () => undefined
    },
    {
      projectPath: () => "/tmp/project",
      sessionCapabilities: { close: true, delete: false }
    }
  );
  const closable = { ...openSession("close-me"), agentKind: "grok", state: "CREATING" as const };
  const created = await adapter.create(closable);
  await adapter.close({ ...closable, nativeSessionId: created.nativeSessionId });
  assert.deepEqual(transport.closes, [created.nativeSessionId]);

  const deletable = { ...openSession("delete-me"), agentKind: "grok", state: "CREATING" as const };
  const second = await adapter.create(deletable);
  await assert.rejects(
    () => adapter.deleteNativeSession({ ...deletable, nativeSessionId: second.nativeSessionId }),
    /当前Grok ACP不支持删除Session/u
  );
  assert.deepEqual(transport.deletes, []);
  assert.equal(adapter.acpSessionFor(deletable.id), second.nativeSessionId);
});

test("Grok native catalog reports a CLI-deleted Session as missing", async () => {
  const grokHome = await mkdtemp("/tmp/agentlink-grok-catalog-");
  const projectRoot = "/tmp/project";
  const nativeSessionId = "019f8fa2-273d-7200-a92e-0a85c7e3e9bc";
  await mkdir(join(
    grokHome,
    "sessions",
    encodeURIComponent(projectRoot),
    nativeSessionId
  ), { recursive: true });
  const transport = new FakeAcpTransport();
  const client = new AcpRpcClient(transport, { requestTimeoutMs: 5_000 });
  await client.initialize("0.0.0-test");
  const adapter = new SharedGrokAdapter(
    client,
    new FakeDigestService(),
    new FakeIdGenerator(),
    {
      turnCompleted: () => undefined,
      approvalRequested: () => undefined,
      runtimeExited: () => undefined,
      protocolError: () => undefined
    },
    { projectPath: () => projectRoot, grokHome }
  );
  assert.deepEqual(await adapter.findMissingNativeSessions([
    { ...openSession("present"), agentKind: "grok", nativeSessionId },
    {
      ...openSession("deleted"),
      agentKind: "grok",
      nativeSessionId: "019f8fa2-273d-7200-a92e-0a85c7e3e999"
    }
  ]), ["deleted"]);
});

test("Grok approval summary includes real input, redacts display secrets, and unknown kind is high risk", async () => {
  const transport = new FakeAcpTransport();
  transport.permissionMode = "request";
  transport.permissionTitle = "Harmless title";
  transport.permissionKind = "mystery";
  const completeCommand = `/bin/zsh -lc '${"echo safe-step ".repeat(24)}--final-marker'`;
  transport.permissionRawInput = {
    command: completeCommand,
    authorization: "Bearer secret-value"
  };
  const client = new AcpRpcClient(transport, { requestTimeoutMs: 5_000 });
  await client.initialize("0.0.0-test");
  let observed: import("../../src/core/domain/model.js").AgentApprovalRequest | undefined;
  const adapter = new SharedGrokAdapter(
    client,
    new FakeDigestService(),
    new FakeIdGenerator(),
    {
      turnCompleted: () => undefined,
      approvalRequested: (request) => {
        observed = request;
        void adapter.resolveApproval(request.id, "deny");
      },
      runtimeExited: () => undefined,
      protocolError: () => undefined
    },
    { projectPath: () => "/tmp/project" }
  );
  await adapter.create({ ...openSession("approval"), agentKind: "grok", state: "CREATING" });
  await adapter.sendTurn({ sessionId: "approval", turnId: "turn", text: "try" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.match(observed?.summary ?? "", /--final-marker/u);
  assert.match(observed?.summary ?? "", new RegExp(completeCommand.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(observed?.summary ?? "", /secret-value/u);
  assert.equal(observed?.risk, "high");
  assert.match(observed?.actionDigest ?? "", /authorization.*Bearer secret-value/u);
});
