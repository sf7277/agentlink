import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SharedClaudeAdapter } from "../../src/agent-claude/adapter/shared-claude-adapter.js";
import {
  claudeSessionFileState,
  encodedClaudeProjectDirectory
} from "../../src/agent-claude/home/write-boundary.js";
import {
  AgentAuthenticationRequiredError,
  DomainError
} from "../../src/core/domain/errors.js";
import { FakeDigestService, FakeIdGenerator, openSession } from "../fakes/core-fakes.js";
import { FakeClaudeSdkClient } from "../fakes/fake-claude-sdk.js";

const PROJECT_ROOT = "/tmp/project";

interface AdapterHarness {
  readonly adapter: SharedClaudeAdapter;
  readonly sdk: FakeClaudeSdkClient;
  readonly completed: { sessionId: string; status: string; text?: string }[];
  readonly approvals: import("../../src/core/domain/model.js").AgentApprovalRequest[];
  readonly exits: { sessionIds: readonly string[]; message: string }[];
}

function harness(options?: {
  claudeHome?: string;
  maxActiveTurns?: number;
  onApproval?: (
    adapter: SharedClaudeAdapter,
    request: import("../../src/core/domain/model.js").AgentApprovalRequest
  ) => void;
}): AdapterHarness {
  const sdk = new FakeClaudeSdkClient();
  const completed: AdapterHarness["completed"] = [];
  const approvals: AdapterHarness["approvals"] = [];
  const exits: AdapterHarness["exits"] = [];
  const adapter = new SharedClaudeAdapter(
    sdk,
    new FakeDigestService(),
    new FakeIdGenerator(),
    {
      turnCompleted: (sessionId, _turnId, status, finalResponse) => {
        completed.push({
          sessionId,
          status,
          ...(finalResponse === undefined ? {} : { text: finalResponse })
        });
      },
      approvalRequested: (request) => {
        approvals.push(request);
        options?.onApproval?.(adapter, request);
      },
      runtimeExited: (sessionIds, error) => {
        exits.push({ sessionIds, message: error.message });
      },
      protocolError: (error) => {
        throw error;
      }
    },
    {
      projectPath: () => PROJECT_ROOT,
      claudeHome: options?.claudeHome ?? "/tmp/agentlink-claude-home-unused",
      ...(options?.maxActiveTurns === undefined
        ? {}
        : { maxActiveTurns: options.maxActiveTurns })
    }
  );
  return { adapter, sdk, completed, approvals, exits };
}

function claudeSession(id: string): ReturnType<typeof openSession> {
  return { ...openSession(id), agentKind: "claude", state: "CREATING" as const };
}

test("SharedClaudeAdapter create + sendTurn completes with the SDK final response", async () => {
  const { adapter, sdk, completed } = harness();
  const created = await adapter.create(claudeSession("session-1"));
  assert.match(created.nativeSessionId, /^0e0e0e0e-/u);
  assert.equal(created.runtimeId, "claude-shared");
  assert.deepEqual(sdk.started, [{ cwd: PROJECT_ROOT }]);
  await adapter.sendTurn({ sessionId: "session-1", turnId: "turn-1", text: "hello" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(completed, [{ sessionId: "session-1", status: "completed", text: "echo:hello" }]);
  assert.equal(adapter.capabilities().steering, false);
  assert.equal(adapter.capabilities().cancellation, true);
  assert.equal(adapter.capabilities().approvals, true);
});

test("SharedClaudeAdapter maps SDK authentication failure to a login instruction", async () => {
  const { adapter, sdk } = harness();
  sdk.authRequired = true;
  await assert.rejects(
    adapter.create(claudeSession("auth")),
    (error: unknown) =>
      error instanceof AgentAuthenticationRequiredError &&
      error.code === "agent_authentication_required" &&
      error.message ===
        "Claude Code认证已失效，请在本机执行 claude 并在对话框中执行 /login 后重试"
  );
});

test("SharedClaudeAdapter resume reports non-terminal turns as UNKNOWN", async () => {
  const { adapter, sdk } = harness();
  const nativeSessionId = "0e0e0e0e-0000-4000-8000-000000000042";
  const session = {
    ...claudeSession("resumed"),
    state: "UNKNOWN" as const,
    nativeSessionId
  };
  const result = await adapter.resume(session, [
    { ...fakeTurn("t-running", "resumed"), state: "RUNNING" as const },
    { ...fakeTurn("t-done", "resumed"), state: "COMPLETED" as const }
  ]);
  assert.deepEqual(sdk.started, [{ cwd: PROJECT_ROOT, resumeNativeSessionId: nativeSessionId }]);
  assert.deepEqual(result.reconciledTurns, [{ turnId: "t-running", state: "UNKNOWN" }]);
});

test("SharedClaudeAdapter surfaces approvals, honors allow_once, and rejects steer", async () => {
  const { adapter, sdk, completed, approvals } = harness({
    onApproval: (owner, request) => {
      void owner.resolveApproval(request.id, "allow_once");
    }
  });
  sdk.permissionMode = "request";
  sdk.permissionToolInput = { command: "rm -rf /tmp/example", authorization: "Bearer secret-value" };
  await adapter.create(claudeSession("session-2"));
  await adapter.sendTurn({ sessionId: "session-2", turnId: "turn-2", text: "write" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.actionKind, "command");
  assert.equal(approvals[0]?.risk, "high");
  assert.match(approvals[0]?.summary ?? "", /rm -rf \/tmp\/example/u);
  assert.doesNotMatch(approvals[0]?.summary ?? "", /secret-value/u);
  assert.match(approvals[0]?.actionDigest ?? "", /Bearer secret-value/u);
  assert.deepEqual(completed, [{
    sessionId: "session-2",
    status: "completed",
    text: "after-permission:allow"
  }]);
  await assert.rejects(
    () => adapter.steer({ sessionId: "session-2", turnId: "turn-2", text: "x" }),
    /steering/u
  );
});

test("SharedClaudeAdapter deny rejects the tool without ending the turn", async () => {
  const { adapter, sdk, completed } = harness({
    onApproval: (owner, request) => {
      void owner.resolveApproval(request.id, "deny");
    }
  });
  sdk.permissionMode = "request";
  await adapter.create(claudeSession("session-3"));
  await adapter.sendTurn({ sessionId: "session-3", turnId: "turn-3", text: "write" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  // Deny must not interrupt: the turn keeps running like the real SDK.
  assert.deepEqual(completed, []);
  assert.deepEqual(sdk.interrupted, []);
  await adapter.cancel("session-3", "turn-3");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(completed, [{ sessionId: "session-3", status: "interrupted" }]);
  await assert.rejects(
    () => adapter.resolveApproval("approval-1", "deny"),
    /no longer pending/u
  );
});

test("SharedClaudeAdapter approval cancel interrupts the running turn", async () => {
  const { adapter, sdk, completed } = harness({
    onApproval: (owner, request) => {
      void owner.resolveApproval(request.id, "cancel");
    }
  });
  sdk.permissionMode = "request";
  await adapter.create(claudeSession("session-cancel"));
  await adapter.sendTurn({ sessionId: "session-cancel", turnId: "turn-c", text: "risky" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  // A cancel decision must end the native turn, not merely deny one tool call,
  // otherwise the core marks the Turn CANCELLED while the SDK keeps running.
  assert.deepEqual(sdk.interrupted, [sdk.sessions[0]!.nativeSessionId]);
  assert.deepEqual(completed, [{ sessionId: "session-cancel", status: "interrupted" }]);
});

test("SharedClaudeAdapter cancel interrupts the turn and clears pending approvals", async () => {
  let observed: import("../../src/core/domain/model.js").AgentApprovalRequest | undefined;
  const { adapter, sdk, completed } = harness({
    onApproval: (_owner, request) => {
      observed = request;
    }
  });
  sdk.permissionMode = "request";
  await adapter.create(claudeSession("session-4"));
  await adapter.sendTurn({ sessionId: "session-4", turnId: "turn-4", text: "risky" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.notEqual(observed, undefined);
  assert.deepEqual(await adapter.inspectApproval(observed!.id), {
    status: "pending",
    nativeRequestId: observed!.nativeRequestId,
    actionDigest: observed!.actionDigest
  });
  await adapter.cancel("session-4", "turn-4");
  assert.deepEqual(sdk.interrupted, [sdk.sessions[0]!.nativeSessionId]);
  assert.deepEqual(await adapter.inspectApproval(observed!.id), { status: "resolved" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(completed, [{ sessionId: "session-4", status: "interrupted" }]);
});

test("SharedClaudeAdapter resume disposes the superseded handle and ignores its events", async () => {
  const { adapter, sdk, exits } = harness();
  const session = claudeSession("rebound");
  const created = await adapter.create(session);
  const first = sdk.sessions[0]!;
  const resumable = {
    ...session,
    state: "UNKNOWN" as const,
    nativeSessionId: created.nativeSessionId
  };
  await adapter.resume(resumable, []);
  // The previous subprocess must be disposed rather than orphaned.
  assert.equal(first.ended, true);
  assert.equal(sdk.sessions.length, 2);

  // A stale handle dying must not unbind the live Session or report an exit.
  first.emitExit(new Error("stale handle died"));
  assert.deepEqual(exits, []);
  await adapter.sendTurn({ sessionId: "rebound", turnId: "t-after", text: "hi" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sdk.sessions[1]!.prompts.length, 1);

  // The live handle still tears the Session down when it dies.
  sdk.sessions[1]!.emitExit(new Error("live handle died"));
  assert.deepEqual(exits, [{ sessionIds: ["rebound"], message: "live handle died" }]);
});

test("SharedClaudeAdapter keeps live sessions out of the missing-native reconciliation", async () => {
  const claudeHome = await mkdtemp("/tmp/agentlink-claude-live-");
  const { adapter } = harness({ claudeHome });
  const session = claudeSession("live");
  const created = await adapter.create(session);
  // No JSONL exists yet, but the live handle proves the native session exists;
  // reporting it missing would let reconciliation delete a fresh Session.
  assert.deepEqual(
    await adapter.findMissingNativeSessions([
      { ...session, nativeSessionId: created.nativeSessionId }
    ]),
    []
  );
});

test("SharedClaudeAdapter forgetNativeSessions disposes the subprocess", async () => {
  const { adapter, sdk } = harness();
  const session = claudeSession("forgotten");
  const created = await adapter.create(session);
  adapter.forgetNativeSessions([{ ...session, nativeSessionId: created.nativeSessionId }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sdk.sessions[0]?.ended, true);
});

test("SharedClaudeAdapter enforces the shared Turn capacity fairly", async () => {
  const { adapter, sdk } = harness({ maxActiveTurns: 1 });
  sdk.promptDelayMs = 30;
  await adapter.create(claudeSession("capacity-1"));
  await adapter.create({ ...claudeSession("capacity-2"), id: "capacity-2" });
  await adapter.sendTurn({ sessionId: "capacity-1", turnId: "t1", text: "first" });
  let secondStarted = false;
  const waiting = adapter.sendTurn({ sessionId: "capacity-2", turnId: "t2", text: "second" })
    .then(() => {
      secondStarted = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(secondStarted, false);
  assert.equal(sdk.promptedTexts.length, 1);
  await waiting;
  assert.equal(secondStarted, true);
  assert.equal(sdk.promptedTexts.length, 2);
});

test("SharedClaudeAdapter close is a definite unsupported rejection", async () => {
  const { adapter } = harness();
  const session = claudeSession("close-me");
  await adapter.create(session);
  await assert.rejects(
    () => adapter.close(session),
    (error: unknown) =>
      error instanceof DomainError &&
      error.code === "native_close_unsupported" &&
      /保持OPEN/u.test(error.message)
  );
});

test("SharedClaudeAdapter deletes only AGENTLINK-owned session files", async () => {
  const claudeHome = await mkdtemp("/tmp/agentlink-claude-adapter-");
  const projectDirectory = join(
    claudeHome,
    "projects",
    encodedClaudeProjectDirectory(PROJECT_ROOT)
  );
  await mkdir(projectDirectory, { recursive: true });
  const { adapter, sdk } = harness({ claudeHome });
  const session = claudeSession("delete-me");
  const created = await adapter.create(session);
  await writeFile(join(projectDirectory, `${created.nativeSessionId}.jsonl`), "{}\n", {
    mode: 0o600
  });
  await adapter.deleteNativeSession({
    ...session,
    nativeSessionId: created.nativeSessionId
  });
  assert.equal(sdk.sessions[0]?.ended, true);
  assert.equal(
    await claudeSessionFileState(claudeHome, PROJECT_ROOT, created.nativeSessionId),
    "missing"
  );

  await assert.rejects(
    () => adapter.deleteNativeSession({
      ...claudeSession("external"),
      nativeSessionId: "0e0e0e0e-0000-4000-8000-000000000099",
      nativeLifecycleOwner: "EXTERNAL" as const
    }),
    (error: unknown) =>
      error instanceof DomainError && error.code === "native_delete_unsupported"
  );
});

test("SharedClaudeAdapter reports externally deleted session files as missing", async () => {
  const claudeHome = await mkdtemp("/tmp/agentlink-claude-catalog-");
  const projectDirectory = join(
    claudeHome,
    "projects",
    encodedClaudeProjectDirectory(PROJECT_ROOT)
  );
  await mkdir(projectDirectory, { recursive: true });
  const presentId = "019f8fa2-273d-7200-a92e-0a85c7e3e9bc";
  await writeFile(join(projectDirectory, `${presentId}.jsonl`), "{}\n", { mode: 0o600 });
  const { adapter } = harness({ claudeHome });
  assert.deepEqual(await adapter.findMissingNativeSessions([
    { ...openSession("present"), agentKind: "claude", nativeSessionId: presentId },
    {
      ...openSession("deleted"),
      agentKind: "claude",
      nativeSessionId: "019f8fa2-273d-7200-a92e-0a85c7e3e999"
    }
  ]), ["deleted"]);
});

test("SharedClaudeAdapter surfaces unexpected session exit and forgets the session", async () => {
  const { adapter, sdk, exits } = harness();
  const session = claudeSession("dying");
  await adapter.create(session);
  sdk.sessions[0]!.emitExit(new Error("claude subprocess exited"));
  assert.deepEqual(exits, [{ sessionIds: ["dying"], message: "claude subprocess exited" }]);
  await assert.rejects(
    () => adapter.sendTurn({ sessionId: "dying", turnId: "t", text: "hi" }),
    /not bound/u
  );
  // A second exit for the same session must not fire the event twice.
  sdk.sessions[0]!.emitExit(new Error("late"));
  assert.equal(exits.length, 1);
});

test("SharedClaudeAdapter discovery lists only importable sessions for this project", async () => {
  const claudeHome = await mkdtemp("/tmp/agentlink-claude-discover-");
  const projectDirectory = join(
    claudeHome,
    "projects",
    encodedClaudeProjectDirectory(PROJECT_ROOT)
  );
  await mkdir(projectDirectory, { recursive: true });
  const importable = "019f8fa2-273d-7200-a92e-0a85c7e3e9bc";
  const alreadyKnown = "029f8fa2-273d-7200-a92e-0a85c7e3e9bc";
  const otherCwd = "039f8fa2-273d-7200-a92e-0a85c7e3e9bc";
  const noFile = "049f8fa2-273d-7200-a92e-0a85c7e3e9bc";
  for (const id of [importable, alreadyKnown, otherCwd]) {
    await writeFile(join(projectDirectory, `${id}.jsonl`), "{}\n", { mode: 0o600 });
  }
  const sdk = new FakeClaudeSdkClient();
  const adapter = new SharedClaudeAdapter(
    sdk,
    new FakeDigestService(),
    new FakeIdGenerator(),
    {
      turnCompleted: () => undefined,
      approvalRequested: () => undefined,
      runtimeExited: () => undefined,
      protocolError: () => undefined
    },
    {
      projectPath: () => PROJECT_ROOT,
      claudeHome,
      knownNativeSessionIds: () => new Set([alreadyKnown])
    }
  );
  sdk.discoverable = [
    { nativeSessionId: importable, title: "可导入会话", lastModifiedMs: 1_700_000_000_000, cwd: PROJECT_ROOT },
    { nativeSessionId: alreadyKnown, title: "已导入", lastModifiedMs: 1_700_000_000_000 },
    { nativeSessionId: otherCwd, title: "其他项目", lastModifiedMs: 1_700_000_000_000, cwd: "/tmp/elsewhere" },
    { nativeSessionId: noFile, title: "无文件", lastModifiedMs: 1_700_000_000_000, cwd: PROJECT_ROOT },
    { nativeSessionId: "../escape", title: "不安全ID", lastModifiedMs: 1_700_000_000_000 }
  ];

  const candidates = await adapter.discoverExternalSessions("project-1", "claude");
  assert.deepEqual(candidates, [{
    nativeSessionId: importable,
    displayName: "可导入会话",
    lastActivityAt: new Date(1_700_000_000_000).toISOString(),
    archived: false
  }]);
  assert.deepEqual(sdk.listedDirectories, [{ cwd: PROJECT_ROOT, limit: 50 }]);
});

test("SharedClaudeAdapter import adopts the chosen session as EXTERNAL without copying history", async () => {
  const claudeHome = await mkdtemp("/tmp/agentlink-claude-import-");
  const projectDirectory = join(
    claudeHome,
    "projects",
    encodedClaudeProjectDirectory(PROJECT_ROOT)
  );
  await mkdir(projectDirectory, { recursive: true });
  const nativeSessionId = "059f8fa2-273d-7200-a92e-0a85c7e3e9bc";
  await writeFile(join(projectDirectory, `${nativeSessionId}.jsonl`), "{}\n", { mode: 0o600 });
  const { adapter, sdk } = harness({ claudeHome });
  const candidate = {
    nativeSessionId,
    displayName: "既有会话",
    lastActivityAt: "2026-07-27T00:00:00.000Z",
    archived: false
  };
  const session = claudeSession("imported");

  const result = await adapter.importExternalSession(session, candidate);
  assert.deepEqual(result, {
    nativeSessionId,
    sourceNativeSessionId: nativeSessionId,
    nativeLifecycleOwner: "EXTERNAL",
    historyTruncated: false,
    runtimeId: "claude-shared",
    displayName: "既有会话",
    lastActivityAt: "2026-07-27T00:00:00.000Z"
  });
  // Adoption is a resume of the user's own session, never a new one.
  assert.deepEqual(sdk.started, [{ cwd: PROJECT_ROOT, resumeNativeSessionId: nativeSessionId }]);

  // An imported (EXTERNAL) session may only be detached, never deleted.
  await assert.rejects(
    () => adapter.deleteNativeSession({
      ...session,
      nativeSessionId,
      nativeLifecycleOwner: "EXTERNAL" as const
    }),
    (error: unknown) =>
      error instanceof DomainError && error.code === "native_delete_unsupported"
  );
  assert.equal(
    await claudeSessionFileState(claudeHome, PROJECT_ROOT, nativeSessionId),
    "file"
  );
});

test("SharedClaudeAdapter import refuses a missing session and rollback keeps native data", async () => {
  const claudeHome = await mkdtemp("/tmp/agentlink-claude-import-fail-");
  await mkdir(join(claudeHome, "projects", encodedClaudeProjectDirectory(PROJECT_ROOT)), {
    recursive: true
  });
  const { adapter, sdk } = harness({ claudeHome });
  const session = claudeSession("import-missing");
  await assert.rejects(
    () => adapter.importExternalSession(session, {
      nativeSessionId: "069f8fa2-273d-7200-a92e-0a85c7e3e9bc",
      displayName: "已删除",
      lastActivityAt: "2026-07-27T00:00:00.000Z",
      archived: false
    }),
    (error: unknown) =>
      error instanceof DomainError && error.code === "external_session_missing"
  );
  assert.equal(sdk.started.length, 0);

  await assert.rejects(
    () => adapter.importExternalSession(session, {
      nativeSessionId: "../escape",
      displayName: "不安全",
      lastActivityAt: "2026-07-27T00:00:00.000Z",
      archived: false
    }),
    (error: unknown) =>
      error instanceof DomainError && error.code === "native_session_id_invalid"
  );

  // Rollback releases only AgentLink's binding; the native file is untouched.
  const nativeSessionId = "079f8fa2-273d-7200-a92e-0a85c7e3e9bc";
  const path = join(
    claudeHome,
    "projects",
    encodedClaudeProjectDirectory(PROJECT_ROOT),
    `${nativeSessionId}.jsonl`
  );
  await writeFile(path, "{}\n", { mode: 0o600 });
  const candidate = {
    nativeSessionId,
    displayName: "回滚",
    lastActivityAt: "2026-07-27T00:00:00.000Z",
    archived: false
  };
  await adapter.importExternalSession(session, candidate);
  await adapter.rollbackExternalSessionImport(session, candidate);
  assert.equal(sdk.sessions.at(-1)?.ended, true);
  assert.equal(
    await claudeSessionFileState(claudeHome, PROJECT_ROOT, nativeSessionId),
    "file"
  );
});

function fakeTurn(id: string, sessionId: string) {
  return {
    id,
    sessionId,
    state: "RUNNING" as const,
    inputSequence: 1,
    sourceEndpointId: "endpoint-1",
    text: "text",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z"
  };
}
