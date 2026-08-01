import { z } from "zod";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentPort,
  AgentResumeOptions,
  AgentResumeResult,
  AgentTurnRequest,
  DigestService,
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
  AcpRpcClient,
  RpcResponseError,
  type ReverseRequest
} from "../protocol/acp-rpc-client.js";

const sessionNewSchema = z.object({
  sessionId: z.string().min(1)
}).passthrough();

const promptResultSchema = z.object({
  stopReason: z.string().optional()
}).passthrough();

const permissionParamsSchema = z.object({
  sessionId: z.string().min(1).optional(),
  options: z.array(z.object({
    optionId: z.string().min(1),
    name: z.string().optional(),
    kind: z.string().optional()
  }).passthrough()).default([]),
  toolCall: z.object({
    toolCallId: z.string().optional(),
    kind: z.string().optional(),
    title: z.string().optional(),
    rawInput: z.unknown().optional()
  }).passthrough().optional()
}).passthrough();

interface PendingApproval {
  readonly reverse: ReverseRequest;
  readonly request: AgentApprovalRequest;
  readonly optionIds: readonly string[];
}

interface ActivePrompt {
  readonly sessionId: string;
  readonly gatewayTurnId: string;
  readonly nativeTurnId: string;
  readonly acpSessionId: string;
  messageChunks: string[];
}

export interface GrokAdapterEvents {
  turnStarted?(sessionId: string, gatewayTurnId: string, nativeTurnId: string): void;
  turnCompleted(
    sessionId: string,
    gatewayTurnId: string,
    status: "completed" | "interrupted" | "failed",
    finalResponse?: string
  ): void;
  approvalRequested(request: AgentApprovalRequest): void;
  approvalResolved?(sessionId: string, gatewayTurnId: string): void;
  sessionNameUpdated?(sessionId: string, displayName: string): void;
  runtimeExited(affectedSessionIds: readonly string[], error: Error): void;
  protocolError(error: Error): void;
}

export interface SharedGrokAdapterOptions {
  readonly projectPath: (projectId: string) => string;
  readonly grokHome?: string;
  readonly runtimeId?: string;
  readonly clock?: () => string;
  readonly maxActiveTurns?: number;
  readonly sessionCapabilities?: {
    readonly close: boolean;
    readonly delete: boolean;
  };
}

export class SharedGrokAdapter implements AgentPort {
  readonly #sessionToAcp = new Map<string, string>();
  readonly #acpToSession = new Map<string, string>();
  readonly #projectRootBySession = new Map<string, string>();
  readonly #activeBySession = new Map<string, ActivePrompt>();
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  readonly #capacity: FairCapacityGate;
  readonly #capacityReleaseBySession = new Map<string, () => void>();
  readonly #runtimeId: string;
  readonly #clock: () => string;

  public constructor(
    private readonly client: AcpRpcClient,
    private readonly digest: DigestService,
    private readonly ids: IdGenerator,
    private readonly events: GrokAdapterEvents,
    private readonly options: SharedGrokAdapterOptions
  ) {
    this.#runtimeId = options.runtimeId ?? "grok-shared";
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#capacity = new FairCapacityGate(options.maxActiveTurns ?? 4);
    client.on("notification", (method: string, params: unknown) => {
      this.handleNotification(method, params);
    });
    client.on("request", (request: ReverseRequest) => {
      void this.handleReverseRequest(request);
    });
    client.on("protocolError", (error: Error) => events.protocolError(error));
    client.on("close", (error: Error) => {
      const affected = [...this.#sessionToAcp.keys()];
      this.clearRuntimeState();
      events.runtimeExited(affected, error);
    });
  }

  public capabilities(): AgentCapabilities {
    return { steering: false, cancellation: true, approvals: true };
  }

  public async findMissingNativeSessions(
    sessions: readonly AgentSession[]
  ): Promise<readonly string[]> {
    if (this.options.grokHome === undefined) return [];
    const missing: string[] = [];
    for (const session of sessions) {
      const nativeSessionId = session.nativeSessionId;
      if (nativeSessionId === undefined) continue;
      if (!isSafeNativeSessionId(nativeSessionId)) {
        throw new Error("Grok native Session ID is not a safe path component");
      }
      const projectRoot = this.options.projectPath(session.projectId);
      const nativePath = join(
        this.options.grokHome,
        "sessions",
        encodeURIComponent(projectRoot),
        nativeSessionId
      );
      try {
        const metadata = await lstat(nativePath);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw new Error("Grok native Session path is not a directory");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          missing.push(session.id);
          continue;
        }
        throw error;
      }
    }
    return missing;
  }

  public forgetNativeSessions(sessions: readonly AgentSession[]): void {
    for (const session of sessions) {
      const acpSessionId = this.#sessionToAcp.get(session.id) ?? session.nativeSessionId;
      if (acpSessionId !== undefined) this.forgetSession(session.id, acpSessionId);
      for (const [requestId, pending] of this.#pendingApprovals) {
        if (pending.request.sessionId === session.id) {
          this.#pendingApprovals.delete(requestId);
        }
      }
    }
  }

  public async create(session: AgentSession): Promise<{ nativeSessionId: string; runtimeId: string }> {
    const projectRoot = this.options.projectPath(session.projectId);
    const response = sessionNewSchema.parse(await this.requestSessionLifecycle("session/new", {
      cwd: projectRoot,
      mcpServers: []
    }));
    this.bindSession(session.id, response.sessionId);
    this.#projectRootBySession.set(session.id, projectRoot);
    return { nativeSessionId: response.sessionId, runtimeId: this.#runtimeId };
  }

  public async resume(
    session: AgentSession,
    turns: readonly Turn[],
    _options?: AgentResumeOptions
  ): Promise<AgentResumeResult> {
    const nativeId = session.nativeSessionId;
    if (nativeId === undefined) throw new Error("Grok Session has no native session id");
    const projectRoot = this.options.projectPath(session.projectId);
    await this.requestSessionLifecycle("session/load", {
      sessionId: nativeId,
      cwd: projectRoot,
      mcpServers: []
    });
    this.bindSession(session.id, nativeId);
    this.#projectRootBySession.set(session.id, projectRoot);
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
    const acpSessionId = this.requireAcpSession(request.sessionId);
    if (this.#activeBySession.has(request.sessionId)) {
      throw new Error("Grok session already has an active Turn");
    }
    const release = await this.#capacity.acquire();
    if (this.#activeBySession.has(request.sessionId)) {
      release();
      throw new Error("Grok session already has an active Turn");
    }
    const nativeTurnId = this.ids.next("gturn");
    const active: ActivePrompt = {
      sessionId: request.sessionId,
      gatewayTurnId: request.turnId,
      nativeTurnId,
      acpSessionId,
      messageChunks: []
    };
    this.#activeBySession.set(request.sessionId, active);
    this.#capacityReleaseBySession.set(request.sessionId, release);
    this.events.turnStarted?.(request.sessionId, request.turnId, nativeTurnId);
    void this.runPrompt(active, request.text);
    return { nativeTurnId };
  }

  public async steer(_request: AgentTurnRequest): Promise<void> {
    throw new Error("Grok Adapter does not support steering");
  }

  public async cancel(sessionId: string, _turnId: string): Promise<void> {
    const active = this.#activeBySession.get(sessionId);
    const acpSessionId = active?.acpSessionId ?? this.requireAcpSession(sessionId);
    await this.client.notify("session/cancel", { sessionId: acpSessionId });
    // Pending permission requests must be cancelled per ACP when the turn is cancelled.
    for (const [requestId, pending] of [...this.#pendingApprovals]) {
      if (pending.request.sessionId !== sessionId) continue;
      try {
        await pending.reverse.respond({ outcome: { outcome: "cancelled" } });
      } catch {
        /* ignore */
      }
      this.#pendingApprovals.delete(requestId);
    }
  }

  public async close(session: AgentSession): Promise<void> {
    const acpId = this.#sessionToAcp.get(session.id) ?? session.nativeSessionId;
    if (acpId === undefined) throw new Error("Cannot close without native Grok session id");
    if (this.options.sessionCapabilities?.close !== true) {
      throw new DomainError(
        "native_close_unsupported",
        "当前Grok版本不支持关闭Session；Session仍保持OPEN"
      );
    }
    await this.client.request("session/close", { sessionId: acpId });
    this.forgetSession(session.id, acpId);
  }

  public async detach(session: AgentSession): Promise<void> {
    const acpId = this.#sessionToAcp.get(session.id) ?? session.nativeSessionId;
    if (acpId === undefined) throw new Error("Cannot detach without native Grok session id");
    this.forgetSession(session.id, acpId);
  }

  public async deleteNativeSession(session: AgentSession): Promise<void> {
    const acpId = this.#sessionToAcp.get(session.id) ?? session.nativeSessionId;
    if (acpId === undefined) throw new Error("Cannot delete without native Grok session id");
    if (this.options.sessionCapabilities?.delete !== true) {
      throw new DomainError(
        "native_delete_unsupported",
        "当前Grok ACP不支持删除Session，请使用电脑端Grok CLI删除"
      );
    }
    await this.client.request("session/delete", { sessionId: acpId });
    this.forgetSession(session.id, acpId);
  }

  public async resolveApproval(
    requestId: string,
    decision: "allow_once" | "deny" | "cancel"
  ): Promise<void> {
    const pending = this.#pendingApprovals.get(requestId);
    if (pending === undefined) throw new Error("Approval request is no longer pending");
    if (decision === "cancel") {
      await pending.reverse.respond({ outcome: { outcome: "cancelled" } });
      this.#pendingApprovals.delete(requestId);
      return;
    }
    const optionId = decision === "allow_once"
      ? pickOptionId(pending.optionIds, "allow-once")
      : pickOptionId(pending.optionIds, "reject-once");
    if (optionId === undefined) {
      throw new Error(`Grok permission options missing mapping for ${decision}`);
    }
    await pending.reverse.respond({
      outcome: { outcome: "selected", optionId }
    });
    this.#pendingApprovals.delete(requestId);
  }

  private async requestSessionLifecycle(
    method: "session/new" | "session/load",
    params: unknown
  ): Promise<unknown> {
    try {
      return await this.client.request(method, params);
    } catch (error) {
      if (
        error instanceof RpcResponseError &&
        error.rpcError.code === -32000 &&
        /authentication required/iu.test(error.rpcError.message)
      ) {
        const loginCommand = this.options.grokHome === undefined
          ? "grok login"
          : `GROK_HOME=${shellQuote(this.options.grokHome)} grok login`;
        throw new AgentAuthenticationRequiredError("Grok", loginCommand);
      }
      throw error;
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

  public acpSessionFor(sessionId: string): string | undefined {
    return this.#sessionToAcp.get(sessionId);
  }

  private async runPrompt(active: ActivePrompt, text: string): Promise<void> {
    try {
      const result = promptResultSchema.parse(await this.client.request("session/prompt", {
        sessionId: active.acpSessionId,
        prompt: [{ type: "text", text }]
      }));
      const stop = (result.stopReason ?? "end_turn").toLowerCase();
      const finalResponse = active.messageChunks.join("");
      if (stop.includes("cancel") || stop.includes("interrupt")) {
        this.events.turnCompleted(active.sessionId, active.gatewayTurnId, "interrupted");
        return;
      }
      if (stop.includes("fail") || stop.includes("error")) {
        this.events.turnCompleted(
          active.sessionId,
          active.gatewayTurnId,
          "failed",
          finalResponse || undefined
        );
        return;
      }
      this.events.turnCompleted(
        active.sessionId,
        active.gatewayTurnId,
        "completed",
        finalResponse
      );
    } catch (error) {
      this.events.turnCompleted(
        active.sessionId,
        active.gatewayTurnId,
        "failed",
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      this.#activeBySession.delete(active.sessionId);
      this.releaseCapacity(active.sessionId);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const body = params as {
      sessionId?: string;
      update?: {
        sessionUpdate?: string;
        content?: { text?: string };
        text?: string;
        title?: string;
      };
    };
    const sessionId = body.sessionId === undefined
      ? undefined
      : this.#acpToSession.get(body.sessionId);
    if (sessionId === undefined) return;
    const update = body.update;
    if (
      update?.sessionUpdate === "session_info_update" &&
      typeof update.title === "string" &&
      update.title.trim() !== ""
    ) {
      this.events.sessionNameUpdated?.(sessionId, update.title);
      return;
    }
    const active = this.#activeBySession.get(sessionId);
    if (active === undefined) return;
    if (update?.sessionUpdate === "agent_message_chunk") {
      const text = update.content?.text ?? update.text;
      if (typeof text === "string" && text.length > 0) active.messageChunks.push(text);
    }
  }

  private async handleReverseRequest(reverse: ReverseRequest): Promise<void> {
    if (reverse.method === "fs/read_text_file") {
      await reverse.reject({ code: -32601, message: "AgentLink does not provide host file reading" });
      return;
    }
    if (reverse.method !== "session/request_permission") {
      await reverse.reject({
        code: -32601,
        message: `AgentLink Grok Adapter does not implement ${reverse.method}`
      });
      return;
    }
    const params = permissionParamsSchema.parse(reverse.params);
    const acpSessionId = params.sessionId;
    const sessionId = acpSessionId === undefined
      ? undefined
      : this.#acpToSession.get(acpSessionId);
    const active = sessionId === undefined ? undefined : this.#activeBySession.get(sessionId);
    if (sessionId === undefined || active === undefined) {
      await reverse.respond({ outcome: { outcome: "cancelled" } });
      return;
    }
    const toolCallId = params.toolCall?.toolCallId ?? this.ids.next("tool");
    const toolCall = params.toolCall === undefined
      ? undefined
      : {
          ...(params.toolCall.title === undefined ? {} : { title: params.toolCall.title }),
          ...(params.toolCall.kind === undefined ? {} : { kind: params.toolCall.kind }),
          ...(params.toolCall.rawInput === undefined ? {} : { rawInput: params.toolCall.rawInput })
        };
    const action = canonicalAction(toolCallId, toolCall);
    const summary = permissionSummary(toolCall, action.displayInput);
    const actionDigest = this.digest.digest([
      sessionId,
      active.gatewayTurnId,
      toolCallId,
      action.kind,
      action.digestInput
    ]);
    const requestId = this.ids.next("approval");
    const request: AgentApprovalRequest = {
      id: requestId,
      nativeRequestId: String(reverse.id),
      nativeItemId: toolCallId,
      sessionId,
      turnId: active.gatewayTurnId,
      actionKind: toolCall?.kind ?? "tool",
      actionDigest,
      summary,
      risk: riskForKind(toolCall?.kind),
      observedAt: this.#clock()
    };
    this.#pendingApprovals.set(requestId, {
      reverse,
      request,
      optionIds: params.options.map((option) => option.optionId)
    });
    this.events.approvalRequested(request);
  }

  private bindSession(sessionId: string, acpSessionId: string): void {
    this.#sessionToAcp.set(sessionId, acpSessionId);
    this.#acpToSession.set(acpSessionId, sessionId);
  }

  private forgetSession(sessionId: string, acpSessionId: string): void {
    this.#sessionToAcp.delete(sessionId);
    this.#acpToSession.delete(acpSessionId);
    this.#projectRootBySession.delete(sessionId);
    this.#activeBySession.delete(sessionId);
    this.releaseCapacity(sessionId);
  }

  private requireAcpSession(sessionId: string): string {
    const acp = this.#sessionToAcp.get(sessionId);
    if (acp === undefined) throw new Error("Session is not bound to a Grok ACP session");
    return acp;
  }

  private clearRuntimeState(): void {
    this.#capacity.close(new Error("Grok shared Runtime exited"));
    for (const release of this.#capacityReleaseBySession.values()) release();
    this.#capacityReleaseBySession.clear();
    this.#sessionToAcp.clear();
    this.#acpToSession.clear();
    this.#projectRootBySession.clear();
    this.#activeBySession.clear();
    this.#pendingApprovals.clear();
  }

  private releaseCapacity(sessionId: string): void {
    const release = this.#capacityReleaseBySession.get(sessionId);
    if (release === undefined) return;
    this.#capacityReleaseBySession.delete(sessionId);
    release();
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
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
      return Promise.reject(new Error("Grok shared Runtime waiting Turn capacity reached"));
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

function pickOptionId(options: readonly string[], preferred: string): string | undefined {
  return options.find((id) => id === preferred) ??
    options.find((id) => id.includes(preferred.replace("-", ""))) ??
    options.find((id) => id.includes(preferred));
}

function isSafeNativeSessionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value);
}

function permissionSummary(toolCall: {
  title?: string;
  kind?: string;
  rawInput?: unknown;
} | undefined, displayInput: string): string {
  const title = toolCall?.title?.trim();
  const prefix = `Grok ${toolCall?.kind ?? "unknown"}`;
  const command = commandFromRawInput(toolCall?.rawInput);
  const summary = `${prefix}${title === undefined || title === "" ? "" : `: ${title.slice(0, 120)}`} | ` +
    (command ?? displayInput);
  return command === undefined ? summary.slice(0, 400) : summary;
}

function commandFromRawInput(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const command = (value as Record<string, unknown>)["command"];
  return typeof command === "string" ? command : undefined;
}

function riskForKind(kind: string | undefined): "low" | "medium" | "high" {
  if (kind === "execute") return "high";
  if (kind === "edit" || kind === "write") return "medium";
  return "high";
}

function canonicalAction(
  toolCallId: string,
  toolCall: { kind?: string; rawInput?: unknown } | undefined
): { kind: string; digestInput: string; displayInput: string } {
  const kind = toolCall?.kind?.trim().toLowerCase() || "unknown";
  return {
    kind,
    digestInput: stableBoundedJson({ toolCallId, kind, rawInput: toolCall?.rawInput }, false),
    displayInput: stableBoundedJson(toolCall?.rawInput ?? {}, true)
  };
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
