import { z } from "zod";
import { isAbsolute, relative, sep } from "node:path";
import {
  prepareBoundedRolloutImport,
  type BoundedRolloutOptions
} from "./bounded-rollout-import.js";
import type {
  AgentResumeOptions,
  AgentResumeResult,
  AgentPort,
  AgentTurnRequest,
  DigestService,
  ExternalAgentSessionCandidate,
  IdGenerator
} from "../../core/contracts/ports.js";
import { AgentOperationUncertainError } from "../../core/domain/errors.js";
import type {
  AgentApprovalRequest,
  AgentCapabilities,
  AgentSession,
  Turn
} from "../../core/domain/model.js";
import {
  JsonlRpcClient,
  RpcResponseError,
  type ReverseRequest
} from "../protocol/jsonl-rpc-client.js";

const threadResponseSchema = z.object({
  thread: z.object({ id: z.string().min(1) }).passthrough()
}).passthrough();
const turnResponseSchema = z.object({
  turn: z.object({ id: z.string().min(1) }).passthrough()
}).passthrough();
const turnStartedSchema = z.object({
  threadId: z.string().min(1),
  turn: z.object({ id: z.string().min(1) }).passthrough()
}).passthrough();
const turnCompletedSchema = z.object({
  threadId: z.string().min(1),
  turn: z.object({
    id: z.string().min(1),
    status: z.enum(["completed", "interrupted", "failed", "inProgress"])
  }).passthrough()
}).passthrough();
const itemCompletedSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  item: z.object({
    id: z.string().min(1),
    type: z.string().min(1)
  }).passthrough()
}).passthrough();
const approvalSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1)
}).passthrough();
const threadReadSchema = z.object({
  thread: z.object({
    id: z.string().min(1),
    name: z.string().nullable().optional(),
    status: z.object({
      type: z.enum(["notLoaded", "idle", "systemError", "active"]),
      activeFlags: z.array(z.string()).optional()
    }).passthrough(),
    turns: z.array(z.object({
      id: z.string().min(1),
      status: z.enum(["completed", "interrupted", "failed", "inProgress"])
    }).passthrough())
  }).passthrough()
}).passthrough();
const serverRequestResolvedSchema = z.object({
  threadId: z.string().min(1),
  requestId: z.union([z.string(), z.number()])
}).passthrough();
const threadNameUpdatedSchema = z.object({
  threadId: z.string().min(1),
  threadName: z.string().nullable().optional()
}).passthrough();
const externalThreadSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
  preview: z.string(),
  cwd: z.string().min(1),
  ephemeral: z.boolean(),
  source: z.union([
    z.enum(["cli", "vscode", "exec", "appServer", "unknown"]),
    z.object({ custom: z.string() }).passthrough(),
    z.object({ subAgent: z.unknown() }).passthrough()
  ]),
  status: z.object({
    type: z.enum(["notLoaded", "idle", "systemError", "active"])
  }).passthrough(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  turns: z.array(z.object({
    id: z.string().min(1),
    status: z.enum(["completed", "interrupted", "failed", "inProgress"])
  }).passthrough()).default([])
}).passthrough();
const threadListSchema = z.object({
  data: z.array(externalThreadSchema),
  nextCursor: z.string().nullable(),
  backwardsCursor: z.string().nullable()
}).passthrough();
/** Import verification does not need full turn payloads (avoids app-server line limits). */
const externalThreadReadSchema = z.object({
  thread: externalThreadSchema
}).passthrough();

const IMPORTABLE_SOURCES = new Set(["cli", "vscode", "exec", "appServer"]);
const MAX_DISCOVERY_PAGES = 20;

function isNoRolloutError(error: unknown, threadId: string): boolean {
  return error instanceof RpcResponseError &&
    error.rpcError.code === -32600 &&
    error.rpcError.message === `no rollout found for thread id ${threadId}`;
}

type ApprovalKind = "command" | "file" | "permissions";

interface PendingApproval {
  readonly kind: ApprovalKind;
  readonly reverse: ReverseRequest;
  readonly request: AgentApprovalRequest;
}

export interface CodexAdapterEvents {
  turnStarted(sessionId: string, gatewayTurnId: string, nativeTurnId: string): void;
  turnCompleted(
    sessionId: string,
    gatewayTurnId: string,
    status: "completed" | "interrupted" | "failed",
    finalResponse?: string
  ): void;
  approvalRequested(request: AgentApprovalRequest): void;
  approvalResolved?(sessionId: string, gatewayTurnId: string): void;
  threadNameUpdated?(sessionId: string, displayName: string): void;
  runtimeExited(affectedSessionIds: readonly string[], error: Error): void;
  protocolError(error: Error): void;
}

export interface SharedCodexAdapterOptions {
  readonly projectPath: (projectId: string) => string;
  readonly runtimeId?: string;
  readonly maxActiveTurns?: number;
  readonly boundedRollout?: BoundedRolloutOptions;
}

export class SharedCodexAdapter implements AgentPort {
  readonly #sessionToThread = new Map<string, string>();
  readonly #threadToSession = new Map<string, string>();
  readonly #projectRootBySession = new Map<string, string>();
  readonly #gatewayToNativeTurn = new Map<string, string>();
  readonly #nativeToGatewayTurn = new Map<string, string>();
  readonly #pendingGatewayTurnByThread = new Map<string, string>();
  readonly #finalResponseByNativeTurn = new Map<string, string>();
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  readonly #capacity: FairCapacityGate;
  readonly #capacityReleaseByThread = new Map<string, () => void>();
  readonly #runtimeId: string;
  readonly #continuationThreadByImportSession = new Map<string, string>();

  public constructor(
    private readonly client: JsonlRpcClient,
    private readonly digest: DigestService,
    private readonly ids: IdGenerator,
    private readonly events: CodexAdapterEvents,
    private readonly options: SharedCodexAdapterOptions
  ) {
    this.#runtimeId = options.runtimeId ?? "codex-shared";
    this.#capacity = new FairCapacityGate(options.maxActiveTurns ?? 4);
    client.on("notification", (method: string, params: unknown) => {
      this.handleNotification(method, params);
    });
    client.on("request", (request: ReverseRequest) => {
      this.handleReverseRequest(request);
    });
    client.on("protocolError", (error: Error) => events.protocolError(error));
    client.on("close", (error: Error) => {
      const affected = [...this.#sessionToThread.keys()];
      this.clearRuntimeState();
      events.runtimeExited(affected, error);
    });
  }

  public capabilities(): AgentCapabilities {
    return { steering: true, cancellation: true, approvals: true };
  }

  public async findMissingNativeSessions(
    sessions: readonly AgentSession[]
  ): Promise<readonly string[]> {
    const byProject = new Map<string, AgentSession[]>();
    for (const session of sessions) {
      const grouped = byProject.get(session.projectId) ?? [];
      grouped.push(session);
      byProject.set(session.projectId, grouped);
    }
    const missing: string[] = [];
    for (const [projectId, grouped] of byProject) {
      const nativeIds = new Set(
        (await this.discoverExternalSessions(projectId))
          .map((candidate) => candidate.nativeSessionId)
      );
      for (const session of grouped) {
        const nativeSessionId = session.nativeSessionId;
        if (nativeSessionId === undefined || nativeIds.has(nativeSessionId)) continue;
        try {
          const response = externalThreadReadSchema.parse(
            await this.client.request("thread/read", {
              threadId: nativeSessionId,
              includeTurns: false
            })
          );
          if (response.thread.id !== nativeSessionId) {
            throw new Error("Codex returned a different thread ID during native reconciliation");
          }
        } catch (error) {
          if (
            error instanceof RpcResponseError &&
            error.rpcError.code === -32600 &&
            error.rpcError.message === `thread not loaded: ${nativeSessionId}`
          ) {
            missing.push(session.id);
            continue;
          }
          throw error;
        }
      }
    }
    return missing;
  }

  public forgetNativeSessions(sessions: readonly AgentSession[]): void {
    for (const session of sessions) {
      const threadId = this.#sessionToThread.get(session.id) ?? session.nativeSessionId;
      if (threadId !== undefined) this.forgetThread(session.id, threadId);
    }
  }

  public async create(session: AgentSession): Promise<{ nativeSessionId: string; runtimeId: string }> {
    const projectRoot = this.options.projectPath(session.projectId);
    const response = threadResponseSchema.parse(await this.client.request("thread/start", {
      cwd: projectRoot,
      ephemeral: false
    }));
    this.bindThread(session.id, response.thread.id);
    this.#projectRootBySession.set(session.id, projectRoot);
    return { nativeSessionId: response.thread.id, runtimeId: this.#runtimeId };
  }

  public async discoverExternalSessions(
    projectId: string
  ): Promise<readonly ExternalAgentSessionCandidate[]> {
    const projectRoot = this.options.projectPath(projectId);
    const candidates: ExternalAgentSessionCandidate[] = [];
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      for (let page = 0; page < MAX_DISCOVERY_PAGES; page += 1) {
        const response = threadListSchema.parse(await this.client.request("thread/list", {
          cwd: projectRoot,
          archived,
          cursor,
          limit: 100,
          sortKey: "updated_at",
          sortDirection: "desc",
          sourceKinds: ["cli", "vscode", "exec", "appServer"]
        }));
        for (const thread of response.data) {
          if (!isImportableThread(thread, projectRoot)) continue;
          candidates.push({
            nativeSessionId: thread.id,
            displayName: externalThreadName(thread),
            lastActivityAt: unixSecondsToIso(thread.updatedAt),
            archived
          });
        }
        cursor = response.nextCursor;
        if (cursor === null) break;
        if (page === MAX_DISCOVERY_PAGES - 1) {
          throw new Error("Codex thread discovery exceeded the pagination limit");
        }
      }
    }
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (seen.has(candidate.nativeSessionId)) {
        throw new Error("Codex thread discovery returned a duplicate native ID");
      }
      seen.add(candidate.nativeSessionId);
    }
    return candidates.sort((left, right) =>
      right.lastActivityAt.localeCompare(left.lastActivityAt) ||
      left.nativeSessionId.localeCompare(right.nativeSessionId)
    );
  }

  public async importExternalSession(
    session: AgentSession,
    candidate: ExternalAgentSessionCandidate
  ) {
    const projectRoot = this.options.projectPath(session.projectId);
    // Lightweight read: import only needs identity/cwd/status, not full history JSON.
    const before = externalThreadReadSchema.parse(await this.client.request("thread/read", {
      threadId: candidate.nativeSessionId,
      includeTurns: false
    })).thread;
    assertImportableThread(before, candidate.nativeSessionId, projectRoot);
    const bounded = await prepareBoundedRolloutImport(
      candidate.nativeSessionId,
      projectRoot,
      this.options.boundedRollout
    );
    if (bounded !== undefined) {
      let continuationId: string | undefined;
      try {
        const started = threadResponseSchema.parse(await this.client.request("thread/start", {
          cwd: projectRoot,
          ephemeral: false
        }));
        continuationId = started.thread.id;
        await this.client.request("thread/inject_items", {
          threadId: continuationId,
          items: bounded.items
        });
        const verified = externalThreadReadSchema.parse(await this.client.request("thread/read", {
          threadId: continuationId,
          includeTurns: false
        })).thread;
        if (verified.id !== continuationId || verified.cwd !== projectRoot) {
          throw new Error("Codex continuation thread verification failed");
        }
        this.bindThread(session.id, continuationId);
        this.#projectRootBySession.set(session.id, projectRoot);
        this.#continuationThreadByImportSession.set(session.id, continuationId);
        return {
          nativeSessionId: continuationId,
          sourceNativeSessionId: candidate.nativeSessionId,
          nativeLifecycleOwner: "AGENTLINK" as const,
          historyTruncated: true,
          runtimeId: this.#runtimeId,
          displayName: externalThreadName(before),
          lastActivityAt: unixSecondsToIso(before.updatedAt)
        };
      } catch (error) {
        if (continuationId !== undefined) {
          try {
            await this.client.request("thread/delete", { threadId: continuationId });
          } catch (rollbackError) {
            throw new AgentOperationUncertainError(
              "Codex continuation thread could not be rolled back",
              { cause: rollbackError }
            );
          }
        }
        throw error;
      }
    }
    let unarchived = false;
    try {
      if (candidate.archived) {
        await this.client.request("thread/unarchive", { threadId: candidate.nativeSessionId });
        unarchived = true;
      }
      const resumed = threadResponseSchema.parse(await this.client.request("thread/resume", {
        threadId: candidate.nativeSessionId,
        cwd: projectRoot
      }));
      if (resumed.thread.id !== candidate.nativeSessionId) {
        throw new Error("App-server resumed a different external thread ID");
      }
      const verified = externalThreadReadSchema.parse(await this.client.request("thread/read", {
        threadId: candidate.nativeSessionId,
        includeTurns: false
      })).thread;
      assertImportableThread(verified, candidate.nativeSessionId, projectRoot);
      this.bindThread(session.id, verified.id);
      this.#projectRootBySession.set(session.id, projectRoot);
      return {
        nativeSessionId: verified.id,
        sourceNativeSessionId: candidate.nativeSessionId,
        nativeLifecycleOwner: "EXTERNAL" as const,
        historyTruncated: false,
        runtimeId: this.#runtimeId,
        displayName: externalThreadName(verified),
        lastActivityAt: unixSecondsToIso(verified.updatedAt)
      };
    } catch (error) {
      if (unarchived) {
        try {
          await this.client.request("thread/archive", { threadId: candidate.nativeSessionId });
        } catch (rollbackError) {
          throw new AgentOperationUncertainError(
            "Codex external thread unarchive could not be rolled back",
            { cause: rollbackError }
          );
        }
      }
      throw error;
    }
  }

  public async rollbackExternalSessionImport(
    session: AgentSession,
    candidate: ExternalAgentSessionCandidate
  ): Promise<void> {
    const threadId = this.#sessionToThread.get(session.id);
    if (threadId !== undefined) {
      this.#sessionToThread.delete(session.id);
      this.#threadToSession.delete(threadId);
      this.#projectRootBySession.delete(session.id);
    }
    const continuationId = this.#continuationThreadByImportSession.get(session.id);
    if (continuationId !== undefined) {
      await this.client.request("thread/delete", { threadId: continuationId });
      this.#continuationThreadByImportSession.delete(session.id);
      return;
    }
    if (candidate.archived) {
      await this.client.request("thread/archive", {
        threadId: candidate.nativeSessionId
      });
    }
  }

  public async resume(
    session: AgentSession,
    turns: readonly Turn[],
    options: AgentResumeOptions = { reopenClosed: false }
  ): Promise<AgentResumeResult> {
    if (session.nativeSessionId === undefined) throw new Error("Cannot resume without native thread ID");
    const projectRoot = this.options.projectPath(session.projectId);
    let unarchived = false;
    let response: z.infer<typeof threadResponseSchema>;
    try {
      if (options.reopenClosed) {
        await this.client.request("thread/unarchive", { threadId: session.nativeSessionId });
        unarchived = true;
      }
      response = threadResponseSchema.parse(await this.client.request("thread/resume", {
        threadId: session.nativeSessionId,
        cwd: projectRoot
      }));
    } catch (error) {
      if (unarchived) {
        try {
          await this.client.request("thread/archive", { threadId: session.nativeSessionId });
        } catch (rollbackError) {
          throw new AgentOperationUncertainError(
            "Codex thread unarchive could not be rolled back after resume failed",
            { cause: rollbackError }
          );
        }
      }
      throw error;
    }
    if (response.thread.id !== session.nativeSessionId) {
      if (unarchived) {
        try {
          await this.client.request("thread/archive", { threadId: session.nativeSessionId });
        } catch (rollbackError) {
          throw new AgentOperationUncertainError(
            "Codex thread unarchive could not be rolled back after identity verification failed",
            { cause: rollbackError }
          );
        }
      }
      throw new Error("App-server resumed a different thread ID");
    }
    let snapshot: z.infer<typeof threadReadSchema>;
    try {
      snapshot = threadReadSchema.parse(await this.client.request("thread/read", {
        threadId: response.thread.id,
        includeTurns: true
      }));
    } catch (error) {
      if (unarchived) {
        try {
          await this.client.request("thread/archive", { threadId: session.nativeSessionId });
        } catch (rollbackError) {
          throw new AgentOperationUncertainError(
            "Codex thread unarchive could not be rolled back after state verification failed",
            { cause: rollbackError }
          );
        }
      }
      throw error;
    }
    this.bindThread(session.id, response.thread.id);
    this.#projectRootBySession.set(session.id, projectRoot);
    const nativeTurns = new Map(snapshot.thread.turns.map((turn) => [turn.id, turn]));
    const reconciledTurns: AgentResumeResult["reconciledTurns"] = turns
      .filter((turn) => turn.nativeTurnId !== undefined)
      .map((turn) => {
        const nativeTurn = nativeTurns.get(turn.nativeTurnId!);
        if (nativeTurn === undefined) return { turnId: turn.id, state: "UNKNOWN" as const };
        this.bindTurn(turn.id, nativeTurn.id);
        if (nativeTurn.status === "completed") {
          return { turnId: turn.id, state: "COMPLETED" as const };
        }
        if (nativeTurn.status === "interrupted") {
          return { turnId: turn.id, state: "CANCELLED" as const };
        }
        if (nativeTurn.status === "failed") {
          return { turnId: turn.id, state: "FAILED" as const };
        }
        return { turnId: turn.id, state: "RUNNING" as const };
      });
    const active = turns.find((turn) => {
      if (turn.nativeTurnId === undefined) return false;
      return nativeTurns.get(turn.nativeTurnId)?.status === "inProgress";
    });
    if (active !== undefined) {
      const release = await this.#capacity.acquire();
      this.#pendingGatewayTurnByThread.set(response.thread.id, active.id);
      this.#capacityReleaseByThread.set(response.thread.id, release);
    }
    return {
      runtimeId: this.#runtimeId,
      reconciledTurns,
      ...(snapshot.thread.name === undefined || snapshot.thread.name === null
        ? {}
        : { displayName: snapshot.thread.name })
    };
  }

  public async sendTurn(request: AgentTurnRequest): Promise<{ nativeTurnId: string }> {
    const threadId = this.requireThread(request.sessionId);
    if (this.#pendingGatewayTurnByThread.has(threadId)) {
      throw new Error("Codex thread already has an active Turn");
    }
    const release = await this.#capacity.acquire();
    if (this.#pendingGatewayTurnByThread.has(threadId)) {
      release();
      throw new Error("Codex thread already has an active Turn");
    }
    this.#pendingGatewayTurnByThread.set(threadId, request.turnId);
    this.#capacityReleaseByThread.set(threadId, release);
    try {
      const response = turnResponseSchema.parse(await this.client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: request.text, text_elements: [] }]
      }));
      this.bindTurn(request.turnId, response.turn.id);
      return { nativeTurnId: response.turn.id };
    } catch (error) {
      this.#pendingGatewayTurnByThread.delete(threadId);
      this.releaseCapacity(threadId);
      throw error;
    }
  }

  public async steer(request: AgentTurnRequest): Promise<void> {
    const threadId = this.requireThread(request.sessionId);
    const nativeTurnId = this.#gatewayToNativeTurn.get(request.turnId);
    if (nativeTurnId === undefined) throw new Error("Cannot steer an unmapped Turn");
    await this.client.request("turn/steer", {
      threadId,
      expectedTurnId: nativeTurnId,
      input: [{ type: "text", text: request.text, text_elements: [] }]
    });
  }

  public async cancel(sessionId: string, turnId: string): Promise<void> {
    const threadId = this.requireThread(sessionId);
    const nativeTurnId = this.#gatewayToNativeTurn.get(turnId);
    if (nativeTurnId === undefined) throw new Error("Cannot interrupt an unmapped Turn");
    await this.client.request("turn/interrupt", { threadId, turnId: nativeTurnId });
  }

  public async close(session: AgentSession): Promise<void | "empty_session_deleted"> {
    const threadId = this.#sessionToThread.get(session.id) ?? session.nativeSessionId;
    if (threadId === undefined) throw new Error("Cannot close without native thread ID");
    let emptySessionDeleted = false;
    try {
      await this.client.request("thread/archive", { threadId });
    } catch (error) {
      // A brand-new thread has no rollout to archive. It has no conversation
      // history, so remove that exact native residue rather than claim archive.
      if (!isNoRolloutError(error, threadId)) throw error;
      await this.client.request("thread/delete", { threadId });
      emptySessionDeleted = true;
    }
    this.forgetThread(session.id, threadId);
    return emptySessionDeleted ? "empty_session_deleted" : undefined;
  }

  public async detach(session: AgentSession): Promise<void> {
    const threadId = this.#sessionToThread.get(session.id) ?? session.nativeSessionId;
    if (threadId === undefined) throw new Error("Cannot detach without native thread ID");
    this.forgetThread(session.id, threadId);
  }

  public async deleteNativeSession(session: AgentSession): Promise<void> {
    const threadId = this.#sessionToThread.get(session.id) ?? session.nativeSessionId;
    if (threadId === undefined) throw new Error("Cannot delete without native thread ID");
    await this.client.request("thread/delete", { threadId });
    this.forgetThread(session.id, threadId);
  }

  private forgetThread(sessionId: string, threadId: string): void {
    this.#sessionToThread.delete(sessionId);
    this.#threadToSession.delete(threadId);
    this.#projectRootBySession.delete(sessionId);
    this.#pendingGatewayTurnByThread.delete(threadId);
    this.releaseCapacity(threadId);
  }

  public async resolveApproval(
    requestId: string,
    decision: "allow_once" | "deny" | "cancel"
  ): Promise<void> {
    const pending = this.#pendingApprovals.get(requestId);
    if (pending === undefined) throw new Error("Approval request is no longer pending");
    if (pending.kind === "permissions") {
      const params = approvalSchema.parse(pending.reverse.params);
      if (decision === "cancel") {
        await this.client.request("turn/interrupt", {
          threadId: params.threadId,
          turnId: params.turnId
        });
      } else {
        await pending.reverse.respond({
          permissions: decision === "allow_once"
            ? requestedPermissions(pending.reverse.params)
            : {},
          scope: "turn"
        });
      }
      this.#pendingApprovals.delete(requestId);
      return;
    }
    const mappedDecision =
      decision === "allow_once" ? "accept" : decision === "deny" ? "decline" : "cancel";
    await pending.reverse.respond({ decision: mappedDecision });
    this.#pendingApprovals.delete(requestId);
  }

  public async inspectApproval(requestId: string) {
    const pending = this.#pendingApprovals.get(requestId);
    if (pending === undefined) return { status: "resolved" as const };
    const params = approvalSchema.parse(pending.reverse.params);
    try {
      const response = threadReadSchema.parse(await this.client.request("thread/read", {
        threadId: params.threadId,
        includeTurns: true
      }));
      const waiting = response.thread.id === params.threadId &&
        response.thread.status.type === "active" &&
        response.thread.status.activeFlags?.includes("waitingOnApproval") === true &&
        response.thread.turns.some((turn) =>
          turn.id === params.turnId && turn.status === "inProgress"
        );
      return waiting
        ? {
            status: "pending" as const,
            nativeRequestId: pending.request.nativeRequestId,
            actionDigest: pending.request.actionDigest
          }
        : { status: "resolved" as const };
    } catch {
      return { status: "unknown" as const };
    }
  }

  public threadForSession(sessionId: string): string | undefined {
    return this.#sessionToThread.get(sessionId);
  }

  private bindThread(sessionId: string, threadId: string): void {
    const existing = this.#threadToSession.get(threadId);
    if (existing !== undefined && existing !== sessionId) {
      throw new Error("Codex thread is already bound to another Session");
    }
    this.#sessionToThread.set(sessionId, threadId);
    this.#threadToSession.set(threadId, sessionId);
  }

  private bindTurn(gatewayTurnId: string, nativeTurnId: string): void {
    const existing = this.#nativeToGatewayTurn.get(nativeTurnId);
    if (existing !== undefined && existing !== gatewayTurnId) {
      throw new Error("Codex Turn is already bound to another Gateway Turn");
    }
    this.#gatewayToNativeTurn.set(gatewayTurnId, nativeTurnId);
    this.#nativeToGatewayTurn.set(nativeTurnId, gatewayTurnId);
  }

  private requireThread(sessionId: string): string {
    const threadId = this.#sessionToThread.get(sessionId);
    if (threadId === undefined) throw new Error("Session is not bound to a Codex thread");
    return threadId;
  }

  private handleNotification(method: string, params: unknown): void {
    try {
      if (method === "turn/started") {
        const parsed = turnStartedSchema.parse(params);
        const sessionId = this.requireSessionForThread(parsed.threadId);
        const gatewayTurnId = this.#pendingGatewayTurnByThread.get(parsed.threadId);
        if (gatewayTurnId === undefined) throw new Error("turn/started has no pending Gateway Turn");
        this.bindTurn(gatewayTurnId, parsed.turn.id);
        this.events.turnStarted(sessionId, gatewayTurnId, parsed.turn.id);
      } else if (method === "item/completed") {
        const parsed = itemCompletedSchema.parse(params);
        this.requireRoute(parsed.threadId, parsed.turnId);
        if (parsed.item.type === "agentMessage") {
          const text = z.string().parse(parsed.item["text"]);
          this.#finalResponseByNativeTurn.set(parsed.turnId, text);
        }
      } else if (method === "turn/completed") {
        const parsed = turnCompletedSchema.parse(params);
        const route = this.requireRoute(parsed.threadId, parsed.turn.id);
        if (parsed.turn.status === "inProgress") throw new Error("turn/completed cannot be inProgress");
        const finalResponse = this.#finalResponseByNativeTurn.get(parsed.turn.id);
        this.#pendingGatewayTurnByThread.delete(parsed.threadId);
        this.releaseCapacity(parsed.threadId);
        this.#finalResponseByNativeTurn.delete(parsed.turn.id);
        this.events.turnCompleted(
          route.sessionId,
          route.gatewayTurnId,
          parsed.turn.status,
          finalResponse
        );
      } else if (method === "serverRequest/resolved") {
        const parsed = serverRequestResolvedSchema.parse(params);
        this.requireSessionForThread(parsed.threadId);
        const nativeRequestId = String(parsed.requestId);
        for (const [requestId, pending] of this.#pendingApprovals) {
          if (pending.request.nativeRequestId === nativeRequestId) {
            this.#pendingApprovals.delete(requestId);
            this.events.approvalResolved?.(
              pending.request.sessionId,
              pending.request.turnId
            );
          }
        }
      } else if (method === "thread/name/updated") {
        const parsed = threadNameUpdatedSchema.parse(params);
        const sessionId = this.requireSessionForThread(parsed.threadId);
        if (parsed.threadName !== undefined && parsed.threadName !== null) {
          this.events.threadNameUpdated?.(sessionId, parsed.threadName);
        }
      }
    } catch (error) {
      this.events.protocolError(error instanceof Error ? error : new Error("Codex notification error"));
    }
  }

  private handleReverseRequest(reverse: ReverseRequest): void {
    try {
      const methods: Readonly<Record<string, ApprovalKind>> = {
        "item/commandExecution/requestApproval": "command",
        "item/fileChange/requestApproval": "file",
        "item/permissions/requestApproval": "permissions"
      };
      const kind = methods[reverse.method];
      if (kind === undefined) {
        void reverse.reject({ code: -32601, message: "Unsupported server request" });
        return;
      }
      const params = approvalSchema.parse(reverse.params);
      const route = this.requireRoute(params.threadId, params.turnId);
      const requestId = this.ids.next("approval");
      const projectRoot = this.#projectRootBySession.get(route.sessionId);
      if (projectRoot === undefined) throw new Error("Approval Session has no registered project root");
      const actionDigest = this.digest.digest([
        "agentlink-action-v1",
        canonicalJson(normalizeApprovalAction(
          kind, reverse, route.sessionId, route.gatewayTurnId, params.itemId, projectRoot, this.digest
        ))
      ]);
      const approvalRequest: AgentApprovalRequest = {
        id: requestId,
        nativeRequestId: String(reverse.id),
        nativeItemId: params.itemId,
        sessionId: route.sessionId,
        turnId: route.gatewayTurnId,
        actionKind: kind,
        actionDigest,
        summary: approvalSummary(kind, reverse.params),
        risk: kind === "command" || kind === "permissions" ? "high" : "medium",
        observedAt: new Date().toISOString()
      };
      this.#pendingApprovals.set(requestId, { kind, reverse, request: approvalRequest });
      this.events.approvalRequested(approvalRequest);
    } catch (error) {
      this.events.protocolError(error instanceof Error ? error : new Error("Codex request error"));
      void reverse.reject({ code: -32602, message: "Approval request could not be routed" });
    }
  }

  private requireSessionForThread(threadId: string): string {
    const sessionId = this.#threadToSession.get(threadId);
    if (sessionId === undefined) throw new Error(`Unknown Codex thread: ${threadId}`);
    return sessionId;
  }

  private requireRoute(threadId: string, nativeTurnId: string): {
    sessionId: string;
    gatewayTurnId: string;
  } {
    const sessionId = this.requireSessionForThread(threadId);
    const gatewayTurnId = this.#nativeToGatewayTurn.get(nativeTurnId);
    if (gatewayTurnId === undefined) throw new Error(`Unknown Codex Turn: ${nativeTurnId}`);
    const expectedNative = this.#gatewayToNativeTurn.get(gatewayTurnId);
    if (expectedNative !== nativeTurnId) throw new Error("Inconsistent Codex Turn route");
    return { sessionId, gatewayTurnId };
  }

  private clearRuntimeState(): void {
    this.#capacity.close(new Error("Codex shared Runtime exited"));
    for (const release of this.#capacityReleaseByThread.values()) release();
    this.#capacityReleaseByThread.clear();
    this.#sessionToThread.clear();
    this.#threadToSession.clear();
    this.#projectRootBySession.clear();
    this.#gatewayToNativeTurn.clear();
    this.#nativeToGatewayTurn.clear();
    this.#pendingGatewayTurnByThread.clear();
    this.#finalResponseByNativeTurn.clear();
    this.#pendingApprovals.clear();
  }

  private releaseCapacity(threadId: string): void {
    const release = this.#capacityReleaseByThread.get(threadId);
    if (release === undefined) return;
    this.#capacityReleaseByThread.delete(threadId);
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
      return Promise.reject(new Error("Codex shared Runtime waiting Turn capacity reached"));
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isImportableThread(
  thread: z.infer<typeof externalThreadSchema>,
  projectRoot: string
): boolean {
  return thread.cwd === projectRoot &&
    !thread.ephemeral &&
    typeof thread.source === "string" &&
    IMPORTABLE_SOURCES.has(thread.source) &&
    (thread.status.type === "idle" || thread.status.type === "notLoaded") &&
    !thread.turns.some((turn) => turn.status === "inProgress");
}

function assertImportableThread(
  thread: z.infer<typeof externalThreadSchema>,
  expectedId: string,
  projectRoot: string
): void {
  if (thread.id !== expectedId) {
    throw new Error("Codex returned a different external thread ID");
  }
  if (thread.cwd !== projectRoot) {
    throw new Error("Codex external thread cwd does not match the registered project");
  }
  if (thread.ephemeral) throw new Error("Ephemeral Codex threads cannot be imported");
  if (typeof thread.source !== "string" || !IMPORTABLE_SOURCES.has(thread.source)) {
    throw new Error("Codex sub-agent or unknown-source threads cannot be imported");
  }
  if (
    thread.status.type === "active" ||
    thread.status.type === "systemError" ||
    thread.turns.some((turn) => turn.status === "inProgress")
  ) {
    throw new Error("Codex thread is active or cannot be safely imported");
  }
}

function externalThreadName(thread: z.infer<typeof externalThreadSchema>): string {
  const name = thread.name?.trim();
  if (name !== undefined && name !== "") return name;
  const preview = thread.preview.trim();
  return preview === "" ? "既有 Codex Session" : preview;
}

function unixSecondsToIso(value: number): string {
  const milliseconds = value * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("Codex thread timestamp is outside the supported range");
  }
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) throw new Error("Codex thread timestamp is invalid");
  return date.toISOString();
}

function approvalSummary(kind: ApprovalKind, params: unknown): string {
  const value = params as Record<string, unknown>;
  if (kind === "command" && typeof value["command"] === "string") {
    return `Codex请求执行命令：${value["command"]}`;
  }
  if (typeof value["reason"] === "string") return `Codex请求${kind}权限：${value["reason"]}`;
  return `Codex请求${kind}权限`;
}

function requestedPermissions(params: unknown): Readonly<Record<string, unknown>> {
  const value = params as Record<string, unknown>;
  const permissions = value["permissions"];
  if (permissions === null || typeof permissions !== "object" || Array.isArray(permissions)) {
    throw new Error("Permissions approval is missing its requested profile");
  }
  const profile = permissions as Record<string, unknown>;
  return {
    ...(profile["network"] === null || profile["network"] === undefined
      ? {}
      : { network: profile["network"] }),
    ...(profile["fileSystem"] === null || profile["fileSystem"] === undefined
      ? {}
      : { fileSystem: profile["fileSystem"] })
  };
}

function normalizeApprovalAction(
  kind: ApprovalKind,
  reverse: ReverseRequest,
  sessionId: string,
  turnId: string,
  itemId: string,
  projectRoot: string,
  digest: DigestService
): Readonly<Record<string, unknown>> {
  const params = reverse.params as Record<string, unknown>;
  const common = {
    actionType: kind,
    sessionId,
    turnId,
    nativeRequestId: String(reverse.id),
    itemId
  };
  if (kind === "command") {
    return {
      ...common,
      cwd: projectRelativePath(params["cwd"], projectRoot),
      command: params["command"] ?? null,
      commandActions: params["commandActions"] ?? null,
      networkScope: params["networkApprovalContext"] ?? null,
      callbackId: params["approvalId"] ?? null
    };
  }
  if (kind === "file") {
    const patch = params["patch"] ?? params["changes"] ?? null;
    return {
      ...common,
      cwd: ".",
      grantRoot: projectRelativePath(params["grantRoot"], projectRoot),
      patchHash: patch === null
        ? null
        : digest.digest(["agentlink-patch-v1", canonicalJson(patch)])
    };
  }
  return {
    ...common,
    cwd: projectRelativePath(params["cwd"], projectRoot),
    permissions: canonicalUnordered(params["permissions"] ?? {})
  };
}

function projectRelativePath(value: unknown, projectRoot: string): string | null {
  if (typeof value !== "string" || value === "") return null;
  if (!isAbsolute(value)) return value.split(sep).join("/");
  const result = relative(projectRoot, value);
  if (result === ".." || result.startsWith(`..${sep}`) || isAbsolute(result)) {
    return `outside-project:${value}`;
  }
  return result === "" ? "." : result.split(sep).join("/");
}

function canonicalUnordered(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(canonicalUnordered)
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, canonicalUnordered(item)])
    );
  }
  return value;
}
