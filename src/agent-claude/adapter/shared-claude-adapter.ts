import type {
  AgentImportResult,
  AgentPort,
  AgentResumeOptions,
  AgentResumeResult,
  AgentTurnRequest,
  DigestService,
  ExternalAgentSessionCandidate,
  IdGenerator
} from "../../core/contracts/ports.js";
import type {
  AgentApprovalRequest,
  AgentCapabilities,
  AgentSession,
  Turn
} from "../../core/domain/model.js";
import {
  AgentAuthenticationRequiredError,
  DomainError
} from "../../core/domain/errors.js";
import {
  ClaudeSdkAuthenticationRequiredError,
  type ClaudeSdkClient,
  type ClaudeSdkPermissionRequest,
  type ClaudeSdkSessionHandle
} from "../sdk/claude-sdk-client.js";
import {
  claudeSessionFileState,
  deleteOwnedClaudeSessionFile,
  isSafeClaudeNativeSessionId
} from "../home/write-boundary.js";

const CLAUDE_LOGIN_COMMAND = "claude 并在对话框中执行 /login";

interface PendingApproval {
  readonly sdkRequest: ClaudeSdkPermissionRequest;
  readonly request: AgentApprovalRequest;
}

interface ActiveTurn {
  readonly sessionId: string;
  readonly gatewayTurnId: string;
  readonly nativeTurnId: string;
}

export interface ClaudeAdapterEvents {
  turnStarted?(sessionId: string, gatewayTurnId: string, nativeTurnId: string): void;
  turnCompleted(
    sessionId: string,
    gatewayTurnId: string,
    status: "completed" | "interrupted" | "failed",
    finalResponse?: string
  ): void;
  approvalRequested(request: AgentApprovalRequest): void;
  approvalResolved?(sessionId: string, gatewayTurnId: string): void;
  runtimeExited(affectedSessionIds: readonly string[], error: Error): void;
  protocolError(error: Error): void;
}

export interface SharedClaudeAdapterOptions {
  readonly projectPath: (projectId: string) => string;
  /** The shared user Claude home (normally ~/.claude). */
  readonly claudeHome: string;
  readonly runtimeId?: string;
  readonly clock?: () => string;
  readonly maxActiveTurns?: number;
  /** Upper bound on native sessions read during discovery. */
  readonly maxDiscoveredSessions?: number;
  /** Native session ids already owned/imported by AgentLink, excluded from discovery. */
  readonly knownNativeSessionIds?: () => ReadonlySet<string>;
}

export class SharedClaudeAdapter implements AgentPort {
  readonly #handleBySession = new Map<string, ClaudeSdkSessionHandle>();
  /**
   * Generation token per session-start attempt. Each SDK session owns its own
   * subprocess, so a stale handle can still emit events after the session was
   * rebound; callbacks must prove they belong to the current binding.
   */
  readonly #generationBySession = new Map<string, number>();
  #nextGeneration = 1;
  readonly #sessionByNative = new Map<string, string>();
  readonly #projectRootBySession = new Map<string, string>();
  readonly #activeBySession = new Map<string, ActiveTurn>();
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  readonly #capacity: FairCapacityGate;
  readonly #capacityReleaseBySession = new Map<string, () => void>();
  readonly #runtimeId: string;
  readonly #clock: () => string;

  public constructor(
    private readonly client: ClaudeSdkClient,
    private readonly digest: DigestService,
    private readonly ids: IdGenerator,
    private readonly events: ClaudeAdapterEvents,
    private readonly options: SharedClaudeAdapterOptions
  ) {
    this.#runtimeId = options.runtimeId ?? "claude-shared";
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#capacity = new FairCapacityGate(options.maxActiveTurns ?? 4);
  }

  public capabilities(): AgentCapabilities {
    return { steering: false, cancellation: true, approvals: true };
  }

  public async findMissingNativeSessions(
    sessions: readonly AgentSession[]
  ): Promise<readonly string[]> {
    const missing: string[] = [];
    for (const session of sessions) {
      const nativeSessionId = session.nativeSessionId;
      if (nativeSessionId === undefined) continue;
      // A live handle is direct evidence the native session exists; the JSONL
      // may not be flushed yet right after create, and a freshly created
      // Session must never be reconciled away as "externally deleted".
      if (this.#handleBySession.has(session.id)) continue;
      if (!isSafeClaudeNativeSessionId(nativeSessionId)) {
        throw new Error("Claude native Session ID is not a safe path component");
      }
      const projectRoot = this.options.projectPath(session.projectId);
      const state = await claudeSessionFileState(
        this.options.claudeHome,
        projectRoot,
        nativeSessionId
      );
      if (state === "missing") {
        missing.push(session.id);
        continue;
      }
      if (state !== "file") {
        throw new Error("Claude native Session path is not a private regular file");
      }
    }
    return missing;
  }

  public forgetNativeSessions(sessions: readonly AgentSession[]): void {
    for (const session of sessions) {
      // Dispose the subprocess before dropping the mapping; otherwise the
      // reconciliation that forgets an externally deleted Session orphans it.
      const handle = this.#handleBySession.get(session.id);
      if (handle !== undefined) void handle.end().catch(() => undefined);
      this.forgetSession(session.id, handle?.nativeSessionId ?? session.nativeSessionId);
      for (const [requestId, pending] of this.#pendingApprovals) {
        if (pending.request.sessionId === session.id) {
          this.#pendingApprovals.delete(requestId);
        }
      }
    }
  }

  public async create(
    session: AgentSession
  ): Promise<{ nativeSessionId: string; runtimeId: string }> {
    const projectRoot = this.options.projectPath(session.projectId);
    const started = await this.startSessionSafely(session.id, { cwd: projectRoot });
    await this.bindSession(session.id, started, projectRoot);
    return { nativeSessionId: started.handle.nativeSessionId, runtimeId: this.#runtimeId };
  }

  /**
   * Lists the user's own Claude sessions for this project so they can be
   * adopted from the mobile side. Discovery is read-only: it never resumes,
   * modifies or deletes anything, and only reports sessions whose recorded cwd
   * matches the Project's canonical path.
   */
  public async discoverExternalSessions(
    projectId: string,
    _agentKind?: string
  ): Promise<readonly ExternalAgentSessionCandidate[]> {
    const projectRoot = this.options.projectPath(projectId);
    const known = this.options.knownNativeSessionIds?.() ?? new Set<string>();
    const bound = new Set(this.#sessionByNative.keys());
    const summaries = await this.client.listSessions({
      cwd: projectRoot,
      limit: this.options.maxDiscoveredSessions ?? 50
    });
    const candidates: ExternalAgentSessionCandidate[] = [];
    for (const summary of summaries) {
      if (!isSafeClaudeNativeSessionId(summary.nativeSessionId)) continue;
      if (known.has(summary.nativeSessionId) || bound.has(summary.nativeSessionId)) continue;
      // A session recorded against another cwd must never be offered here.
      if (summary.cwd !== undefined && summary.cwd !== projectRoot) continue;
      const state = await claudeSessionFileState(
        this.options.claudeHome,
        projectRoot,
        summary.nativeSessionId
      );
      if (state !== "file") continue;
      candidates.push({
        nativeSessionId: summary.nativeSessionId,
        displayName: summary.title,
        lastActivityAt: new Date(summary.lastModifiedMs).toISOString(),
        // Claude Code has no archive concept; reporting false is the truth.
        archived: false
      });
    }
    return candidates;
  }

  /**
   * Adopts an existing native session by resuming it. No history is copied or
   * replayed: AgentLink only builds a binding, and the native session stays
   * owned by the user's own Claude Code (EXTERNAL lifecycle → detach only).
   */
  public async importExternalSession(
    session: AgentSession,
    candidate: ExternalAgentSessionCandidate
  ): Promise<AgentImportResult> {
    if (!isSafeClaudeNativeSessionId(candidate.nativeSessionId)) {
      throw new DomainError(
        "native_session_id_invalid",
        "Claude原生Session标识不安全，拒绝导入"
      );
    }
    const projectRoot = this.options.projectPath(session.projectId);
    const state = await claudeSessionFileState(
      this.options.claudeHome,
      projectRoot,
      candidate.nativeSessionId
    );
    if (state !== "file") {
      throw new DomainError(
        "external_session_missing",
        "该Claude会话已不存在或不在本项目目录下，无法导入"
      );
    }
    const started = await this.startSessionSafely(session.id, {
      cwd: projectRoot,
      resumeNativeSessionId: candidate.nativeSessionId
    });
    if (started.handle.nativeSessionId !== candidate.nativeSessionId) {
      // Never silently adopt a different native session than the one chosen.
      await started.handle.end().catch(() => undefined);
      throw new DomainError(
        "external_session_identity_mismatch",
        "Claude返回了不同的Session标识"
      );
    }
    await this.bindSession(session.id, started, projectRoot);
    return {
      nativeSessionId: candidate.nativeSessionId,
      sourceNativeSessionId: candidate.nativeSessionId,
      nativeLifecycleOwner: "EXTERNAL",
      historyTruncated: false,
      runtimeId: this.#runtimeId,
      displayName: candidate.displayName,
      lastActivityAt: candidate.lastActivityAt
    };
  }

  /**
   * Import rollback only releases AgentLink's own binding. The native session
   * belongs to the user, so it is never archived, truncated or deleted here.
   */
  public async rollbackExternalSessionImport(
    session: AgentSession,
    _candidate: ExternalAgentSessionCandidate
  ): Promise<void> {
    const handle = this.#handleBySession.get(session.id);
    if (handle !== undefined) await handle.end().catch(() => undefined);
    this.forgetSession(session.id, handle?.nativeSessionId);
  }

  public async resume(
    session: AgentSession,
    turns: readonly Turn[],
    _options?: AgentResumeOptions
  ): Promise<AgentResumeResult> {
    const nativeId = session.nativeSessionId;
    if (nativeId === undefined) throw new Error("Claude Session has no native session id");
    const projectRoot = this.options.projectPath(session.projectId);
    const started = await this.startSessionSafely(session.id, {
      cwd: projectRoot,
      resumeNativeSessionId: nativeId
    });
    await this.bindSession(session.id, started, projectRoot);
    // Claude Code does not expose reliable per-turn terminal facts across a
    // Gateway restart; non-terminal turns stay UNKNOWN instead of being faked.
    const reconciledTurns = turns
      .filter((turn) =>
        turn.state === "DISPATCHED" ||
        turn.state === "RUNNING" ||
        turn.state === "WAITING_AGENT_APPROVAL" ||
        turn.state === "UNKNOWN"
      )
      .map((turn) => ({ turnId: turn.id, state: "UNKNOWN" as const }));
    return { runtimeId: this.#runtimeId, reconciledTurns };
  }

  public async sendTurn(request: AgentTurnRequest): Promise<{ nativeTurnId: string }> {
    const handle = this.requireHandle(request.sessionId);
    const generation = this.#generationBySession.get(request.sessionId);
    if (this.#activeBySession.has(request.sessionId)) {
      throw new Error("Claude session already has an active Turn");
    }
    const release = await this.#capacity.acquire();
    if (this.#activeBySession.has(request.sessionId)) {
      release();
      throw new Error("Claude session already has an active Turn");
    }
    // The Session can exit or be rebound while queued behind the capacity gate;
    // dispatching onto a dead handle would report success for a lost Turn.
    if (this.#generationBySession.get(request.sessionId) !== generation) {
      release();
      throw new Error("Claude session was replaced while waiting for capacity");
    }
    const nativeTurnId = this.ids.next("cturn");
    const active: ActiveTurn = {
      sessionId: request.sessionId,
      gatewayTurnId: request.turnId,
      nativeTurnId
    };
    this.#activeBySession.set(request.sessionId, active);
    this.#capacityReleaseBySession.set(request.sessionId, release);
    this.events.turnStarted?.(request.sessionId, request.turnId, nativeTurnId);
    void this.runPrompt(active, handle, request.text);
    return { nativeTurnId };
  }

  public async steer(_request: AgentTurnRequest): Promise<void> {
    throw new Error("Claude Adapter does not support steering");
  }

  public async cancel(sessionId: string, _turnId: string): Promise<void> {
    const handle = this.requireHandle(sessionId);
    await handle.interrupt();
    // Pending permission callbacks must be resolved so the SDK is not stuck.
    for (const [requestId, pending] of [...this.#pendingApprovals]) {
      if (pending.request.sessionId !== sessionId) continue;
      try {
        pending.sdkRequest.respond("deny", "任务已被停止，审批取消");
      } catch {
        /* ignore */
      }
      this.#pendingApprovals.delete(requestId);
    }
  }

  public async close(_session: AgentSession): Promise<void> {
    throw new DomainError(
      "native_close_unsupported",
      "当前Claude Code不支持关闭Session；Session仍保持OPEN"
    );
  }

  public async detach(session: AgentSession): Promise<void> {
    const handle = this.#handleBySession.get(session.id);
    if (handle !== undefined) await handle.end();
    this.forgetSession(session.id, session.nativeSessionId);
  }

  public async deleteNativeSession(session: AgentSession): Promise<void> {
    const nativeId = session.nativeSessionId;
    if (nativeId === undefined) throw new Error("Cannot delete without native Claude session id");
    if (session.nativeLifecycleOwner !== "AGENTLINK") {
      throw new DomainError(
        "native_delete_unsupported",
        "外部Claude会话仅支持解除关联，AgentLink不会删除本机Claude会话文件"
      );
    }
    const handle = this.#handleBySession.get(session.id);
    if (handle !== undefined) await handle.end();
    await deleteOwnedClaudeSessionFile({
      claudeHome: this.options.claudeHome,
      projectRoot: this.options.projectPath(session.projectId),
      nativeSessionId: nativeId
    });
    this.forgetSession(session.id, nativeId);
  }

  public async resolveApproval(
    requestId: string,
    decision: "allow_once" | "deny" | "cancel"
  ): Promise<void> {
    const pending = this.#pendingApprovals.get(requestId);
    if (pending === undefined) throw new Error("Approval request is no longer pending");
    if (decision === "allow_once") {
      pending.sdkRequest.respond("allow");
      this.#pendingApprovals.delete(requestId);
      return;
    }
    pending.sdkRequest.respond(
      "deny",
      decision === "cancel" ? "审批已取消" : "审批被拒绝"
    );
    this.#pendingApprovals.delete(requestId);
    if (decision !== "cancel") return;
    // Denying one tool call does not end the turn; an explicit cancel must
    // interrupt it, otherwise the core marks the Turn CANCELLED while the SDK
    // keeps running (holding the capacity slot and raising ghost approvals).
    const handle = this.#handleBySession.get(pending.request.sessionId);
    if (handle === undefined) return;
    try {
      await handle.interrupt();
    } catch (error) {
      this.events.protocolError(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  public async inspectApproval(requestId: string) {
    const pending = this.#pendingApprovals.get(requestId);
    if (pending === undefined) return { status: "resolved" as const };
    return {
      status: "pending" as const,
      nativeRequestId: pending.request.nativeRequestId,
      actionDigest: pending.request.actionDigest
    };
  }

  public handleFor(sessionId: string): ClaudeSdkSessionHandle | undefined {
    return this.#handleBySession.get(sessionId);
  }

  private async startSessionSafely(
    sessionId: string,
    options: { cwd: string; resumeNativeSessionId?: string }
  ): Promise<{ handle: ClaudeSdkSessionHandle; generation: number }> {
    const generation = this.#nextGeneration++;
    try {
      const handle = await this.client.startSession({
        cwd: options.cwd,
        ...(options.resumeNativeSessionId === undefined
          ? {}
          : { resumeNativeSessionId: options.resumeNativeSessionId }),
        events: {
          permissionRequested: (request) =>
            this.handlePermissionRequest(sessionId, generation, request),
          exited: (error) => this.handleSessionExit(sessionId, generation, error)
        }
      });
      return { handle, generation };
    } catch (error) {
      if (error instanceof ClaudeSdkAuthenticationRequiredError) {
        throw new AgentAuthenticationRequiredError("Claude Code", CLAUDE_LOGIN_COMMAND);
      }
      throw error;
    }
  }

  private async runPrompt(
    active: ActiveTurn,
    handle: ClaudeSdkSessionHandle,
    text: string
  ): Promise<void> {
    try {
      const result = await handle.prompt(text);
      this.events.turnCompleted(
        active.sessionId,
        active.gatewayTurnId,
        result.status,
        result.finalResponse
      );
    } catch (error) {
      if (error instanceof ClaudeSdkAuthenticationRequiredError) {
        this.events.turnCompleted(
          active.sessionId,
          active.gatewayTurnId,
          "failed",
          new AgentAuthenticationRequiredError("Claude Code", CLAUDE_LOGIN_COMMAND).message
        );
      } else {
        this.events.turnCompleted(
          active.sessionId,
          active.gatewayTurnId,
          "failed",
          error instanceof Error ? error.message : String(error)
        );
      }
    } finally {
      this.#activeBySession.delete(active.sessionId);
      this.releaseCapacity(active.sessionId);
    }
  }

  private handlePermissionRequest(
    sessionId: string,
    generation: number,
    sdkRequest: ClaudeSdkPermissionRequest
  ): void {
    if (this.#generationBySession.get(sessionId) !== generation) {
      // A superseded handle must never raise approvals for the live Session.
      try {
        sdkRequest.respond("deny", "该Claude会话已被替换");
      } catch (error) {
        this.events.protocolError(
          error instanceof Error ? error : new Error(String(error))
        );
      }
      return;
    }
    const active = this.#activeBySession.get(sessionId);
    if (active === undefined) {
      try {
        sdkRequest.respond("deny", "AgentLink没有匹配的活动任务");
      } catch (error) {
        this.events.protocolError(
          error instanceof Error ? error : new Error(String(error))
        );
      }
      return;
    }
    const projectRoot = this.#projectRootBySession.get(sessionId);
    const action = canonicalClaudeAction(
      sdkRequest.toolUseId,
      sdkRequest.toolName,
      sdkRequest.toolInput,
      projectRoot
    );
    const actionDigest = this.digest.digest([
      sessionId,
      active.gatewayTurnId,
      sdkRequest.toolUseId,
      action.kind,
      action.digestInput
    ]);
    const requestId = this.ids.next("approval");
    const request: AgentApprovalRequest = {
      id: requestId,
      nativeRequestId: sdkRequest.toolUseId,
      nativeItemId: sdkRequest.toolUseId,
      sessionId,
      turnId: active.gatewayTurnId,
      actionKind: action.kind,
      actionDigest,
      summary: permissionSummary(sdkRequest.toolName, sdkRequest.toolInput, action.displayInput),
      risk: riskForToolName(sdkRequest.toolName),
      observedAt: this.#clock()
    };
    this.#pendingApprovals.set(requestId, { sdkRequest, request });
    this.events.approvalRequested(request);
  }

  private handleSessionExit(sessionId: string, generation: number, error: Error): void {
    // Only the currently bound handle may tear down the Session; a superseded
    // handle dying must not unbind a live one or report a false runtime exit.
    if (this.#generationBySession.get(sessionId) !== generation) return;
    const nativeId = this.#handleBySession.get(sessionId)?.nativeSessionId;
    this.forgetSession(sessionId, nativeId);
    for (const [requestId, pending] of this.#pendingApprovals) {
      if (pending.request.sessionId === sessionId) {
        this.#pendingApprovals.delete(requestId);
      }
    }
    this.events.runtimeExited([sessionId], error);
  }

  private async bindSession(
    sessionId: string,
    started: { handle: ClaudeSdkSessionHandle; generation: number },
    projectRoot: string
  ): Promise<void> {
    // Rebinding (resume of a still-bound Session) must dispose the previous
    // handle, otherwise its subprocess is orphaned for the Gateway's lifetime.
    const previous = this.#handleBySession.get(sessionId);
    if (previous !== undefined && previous !== started.handle) {
      this.#sessionByNative.delete(previous.nativeSessionId);
      await previous.end().catch(() => undefined);
    }
    this.#handleBySession.set(sessionId, started.handle);
    this.#generationBySession.set(sessionId, started.generation);
    this.#sessionByNative.set(started.handle.nativeSessionId, sessionId);
    this.#projectRootBySession.set(sessionId, projectRoot);
  }

  private forgetSession(sessionId: string, nativeSessionId: string | undefined): void {
    this.#handleBySession.delete(sessionId);
    this.#generationBySession.delete(sessionId);
    if (nativeSessionId !== undefined) this.#sessionByNative.delete(nativeSessionId);
    this.#projectRootBySession.delete(sessionId);
    this.#activeBySession.delete(sessionId);
    this.releaseCapacity(sessionId);
  }

  private requireHandle(sessionId: string): ClaudeSdkSessionHandle {
    const handle = this.#handleBySession.get(sessionId);
    if (handle === undefined) {
      throw new Error("Session is not bound to a Claude SDK session");
    }
    return handle;
  }

  private releaseCapacity(sessionId: string): void {
    const release = this.#capacityReleaseBySession.get(sessionId);
    if (release === undefined) return;
    this.#capacityReleaseBySession.delete(sessionId);
    release();
  }
}

class FairCapacityGate {
  #active = 0;
  #closed: Error | undefined;
  readonly #waiters: {
    readonly resolve: (release: () => void) => void;
    readonly reject: (error: Error) => void;
  }[] = [];

  public constructor(private readonly limit: number, private readonly maxWaiters = 128) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Turn capacity must be positive");
  }

  public acquire(): Promise<() => void> {
    if (this.#closed !== undefined) return Promise.reject(this.#closed);
    if (this.#active < this.limit) {
      this.#active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    if (this.#waiters.length >= this.maxWaiters) {
      return Promise.reject(new Error("Claude Runtime waiting Turn capacity reached"));
    }
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  public close(error: Error): void {
    this.#closed = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.#waiters.shift();
      if (waiter !== undefined && this.#closed === undefined) {
        waiter.resolve(this.releaseOnce());
      } else {
        this.#active = Math.max(0, this.#active - 1);
      }
    };
  }
}

function riskForToolName(toolName: string): "low" | "medium" | "high" {
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
    return "medium";
  }
  // Bash and anything unrecognized stay high; unknown tools must not look safe.
  return "high";
}

function claudeActionKind(toolName: string): string {
  if (toolName === "Bash") return "command";
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
    return "file";
  }
  return "tool";
}

function permissionSummary(toolName: string, toolInput: unknown, displayInput: string): string {
  const command = commandFromToolInput(toolInput);
  const summary = `Claude ${toolName} | ${command ?? displayInput}`;
  return command === undefined ? summary.slice(0, 400) : summary;
}

function commandFromToolInput(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const command = (value as Record<string, unknown>)["command"];
  return typeof command === "string" ? command : undefined;
}

function canonicalClaudeAction(
  toolUseId: string,
  toolName: string,
  toolInput: unknown,
  projectRoot: string | undefined
): { kind: string; digestInput: string; displayInput: string } {
  const kind = claudeActionKind(toolName);
  const relativized = relativizeProjectPaths(toolInput, projectRoot);
  return {
    kind,
    digestInput: stableBoundedJson({ toolUseId, toolName, input: relativized }, false),
    displayInput: stableBoundedJson(relativized ?? {}, true)
  };
}

function relativizeProjectPaths(value: unknown, projectRoot: string | undefined): unknown {
  if (projectRoot === undefined) return value;
  const prefix = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`;
  const walk = (input: unknown, depth: number): unknown => {
    if (depth > 6) return input;
    if (typeof input === "string") {
      if (input === projectRoot) return ".";
      if (input.startsWith(prefix)) return `./${input.slice(prefix.length)}`;
      return input;
    }
    if (Array.isArray(input)) return input.map((item) => walk(item, depth + 1));
    if (input !== null && typeof input === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
        output[key] = walk(item, depth + 1);
      }
      return output;
    }
    return input;
  };
  return walk(value, 0);
}

function stableBoundedJson(value: unknown, redact: boolean): string {
  const normalize = (input: unknown, depth: number, key?: string): unknown => {
    if (depth > 6) return "[depth-limit]";
    if (input === null || typeof input === "boolean" || typeof input === "number") return input;
    if (typeof input === "string") {
      if (redact && key !== undefined && /token|secret|password|cookie|authorization/iu.test(key)) {
        return "[redacted]";
      }
      return input.slice(0, 2_000);
    }
    if (Array.isArray(input)) return input.slice(0, 50).map((item) => normalize(item, depth + 1));
    if (typeof input === "object") {
      const output: Record<string, unknown> = {};
      for (const entry of Object.keys(input as Record<string, unknown>).sort().slice(0, 50)) {
        output[entry] = normalize((input as Record<string, unknown>)[entry], depth + 1, entry);
      }
      return output;
    }
    return String(input).slice(0, 200);
  };
  return JSON.stringify(normalize(value, 0)).slice(0, redact ? 300 : 32_000);
}
