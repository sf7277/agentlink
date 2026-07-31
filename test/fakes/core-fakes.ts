import type {
  AgentImportResult,
  AgentResumeResult,
  AgentPort,
  AgentTurnRequest,
  ChannelMessage,
  ChannelOutput,
  ChannelPort,
  Clock,
  CredentialStore,
  DigestService,
  IdGenerator,
  ProcessRegistry,
  RuntimeSnapshot,
  StateStore,
  Transaction
} from "../../src/core/contracts/ports.js";
import type {
  AgentCapabilities,
  AgentSession,
  Turn
} from "../../src/core/domain/model.js";

export class FakeClock implements Clock {
  public constructor(private value = "2026-07-18T00:00:00.000Z") {}
  public now(): string { return this.value; }
  public set(value: string): void { this.value = value; }
}

export class FakeIdGenerator implements IdGenerator {
  #next = 1;
  public next(prefix: string): string {
    return `${prefix}-${this.#next++}`;
  }
}

export class FakeDigestService implements DigestService {
  public digest(parts: readonly string[]): string { return `digest:${parts.join("|")}`; }
}

class MemoryTransaction implements Transaction {
  public constructor(
    private readonly sessions: Map<string, AgentSession>,
    private readonly turns: Map<string, Turn>
  ) {}
  public getSession(id: string): AgentSession | undefined { return this.sessions.get(id); }
  public putSession(session: AgentSession): void { this.sessions.set(session.id, session); }
  public deleteSession(id: string): void { this.sessions.delete(id); }
  public getTurn(id: string): Turn | undefined { return this.turns.get(id); }
  public putTurn(turn: Turn): void { this.turns.set(turn.id, turn); }
  public listTurns(sessionId: string): readonly Turn[] {
    return [...this.turns.values()]
      .filter((turn) => turn.sessionId === sessionId)
      .sort((left, right) => left.inputSequence - right.inputSequence);
  }
  public nextInputSequence(sessionId: string): number {
    return Math.max(0, ...this.listTurns(sessionId).map((turn) => turn.inputSequence)) + 1;
  }
  public nextQueueSequence(sessionId: string): number {
    return Math.max(0, ...this.listTurns(sessionId).map((turn) => turn.queueSequence ?? 0)) + 1;
  }
}

export class MemoryStateStore implements StateStore {
  readonly sessions = new Map<string, AgentSession>();
  readonly turns = new Map<string, Turn>();

  public transaction<T>(operation: (transaction: Transaction) => T): T {
    const sessions = new Map(this.sessions);
    const turns = new Map(this.turns);
    try {
      return operation(new MemoryTransaction(this.sessions, this.turns));
    } catch (error) {
      this.sessions.clear();
      this.turns.clear();
      for (const entry of sessions) this.sessions.set(...entry);
      for (const entry of turns) this.turns.set(...entry);
      throw error;
    }
  }

  public reconcileStartup(now: string): void {
    for (const [id, session] of this.sessions) {
      if (session.state === "CREATING" || session.state === "OPEN" || session.state === "CLOSING") {
        this.sessions.set(id, {
          ...session,
          state: "UNKNOWN",
          runtimeState: "UNKNOWN",
          queuePaused: true,
          updatedAt: now
        });
      }
    }
    for (const [id, turn] of this.turns) {
      const state = turn.state === "QUEUED"
        ? "PAUSED"
        : turn.state === "DISPATCHED" ||
            turn.state === "RUNNING" ||
            turn.state === "WAITING_AGENT_APPROVAL"
          ? "UNKNOWN"
          : turn.state;
      this.turns.set(id, { ...turn, state, updatedAt: now });
    }
  }
}

export class FakeAgent implements AgentPort {
  readonly created: AgentSession[] = [];
  readonly sent: AgentTurnRequest[] = [];
  readonly steered: AgentTurnRequest[] = [];
  readonly cancelled: { sessionId: string; turnId: string }[] = [];
  readonly closed: string[] = [];
  readonly detached: string[] = [];
  readonly deleted: string[] = [];
  readonly externalDiscoveryProjects: { projectId: string; agentKind?: string }[] = [];
  readonly decisions: { requestId: string; decision: "allow_once" | "deny" | "cancel" }[] = [];
  readonly approvalSnapshots = new Map<string, {
    status: "pending" | "resolved" | "unknown";
    nativeRequestId?: string;
    actionDigest?: string;
  }>();
  readonly missingNativeSessionIds = new Set<string>();
  failNextSend = false;
  onResolveApproval?: (
    requestId: string,
    decision: "allow_once" | "deny" | "cancel"
  ) => void;
  externalSessions: import("../../src/core/contracts/ports.js").ExternalAgentSessionCandidate[] = [];

  public constructor(private readonly features: AgentCapabilities) {}
  public capabilities(): AgentCapabilities { return this.features; }
  public async findMissingNativeSessions(
    sessions: readonly AgentSession[]
  ): Promise<readonly string[]> {
    return sessions
      .filter((session) => this.missingNativeSessionIds.has(session.id))
      .map((session) => session.id);
  }
  public async create(session: AgentSession): Promise<{ nativeSessionId: string; runtimeId: string }> {
    this.created.push(session);
    return { nativeSessionId: `native-${session.id}`, runtimeId: "runtime-1" };
  }
  public async discoverExternalSessions(projectId: string, agentKind?: string) {
    this.externalDiscoveryProjects.push({
      projectId,
      ...(agentKind === undefined ? {} : { agentKind })
    });
    return this.externalSessions;
  }
  public async importExternalSession(
    _session: AgentSession,
    candidate: import("../../src/core/contracts/ports.js").ExternalAgentSessionCandidate
  ): Promise<AgentImportResult> {
    return {
      nativeSessionId: candidate.nativeSessionId,
      sourceNativeSessionId: candidate.nativeSessionId,
      nativeLifecycleOwner: "EXTERNAL" as const,
      historyTruncated: false,
      runtimeId: "runtime-1",
      displayName: candidate.displayName,
      lastActivityAt: candidate.lastActivityAt
    };
  }
  public async resume(
    _session: AgentSession,
    _turns: readonly Turn[]
  ): Promise<AgentResumeResult> {
    return { runtimeId: "runtime-1", reconciledTurns: [] };
  }
  public async sendTurn(request: AgentTurnRequest): Promise<{ nativeTurnId: string }> {
    this.sent.push(request);
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("Injected send uncertainty");
    }
    return { nativeTurnId: `native-${request.turnId}` };
  }
  public async steer(request: AgentTurnRequest): Promise<void> { this.steered.push(request); }
  public async cancel(sessionId: string, turnId: string): Promise<void> {
    this.cancelled.push({ sessionId, turnId });
  }
  public async close(session: AgentSession): Promise<void> { this.closed.push(session.id); }
  public async detach(session: AgentSession): Promise<void> { this.detached.push(session.id); }
  public async deleteNativeSession(session: AgentSession): Promise<void> {
    this.deleted.push(session.id);
  }
  public async resolveApproval(
    requestId: string,
    decision: "allow_once" | "deny" | "cancel"
  ): Promise<void> {
    this.decisions.push({ requestId, decision });
    this.onResolveApproval?.(requestId, decision);
  }
  public async inspectApproval(requestId: string): Promise<{
    status: "pending" | "resolved" | "unknown";
    nativeRequestId?: string;
    actionDigest?: string;
  }> {
    return this.approvalSnapshots.get(requestId) ?? {
      status: "pending",
      nativeRequestId: "native-request-1",
      actionDigest: "digest-1"
    };
  }
}

export class FakeChannel implements ChannelPort {
  readonly sent: ChannelOutput[] = [];
  #handler: ((message: ChannelMessage) => Promise<void>) | undefined;
  failSends = false;
  public async start(handler: (message: ChannelMessage) => Promise<void>): Promise<void> {
    this.#handler = handler;
  }
  public async stop(): Promise<void> { this.#handler = undefined; }
  public async send(output: ChannelOutput): Promise<void> {
    if (this.failSends) throw new Error("Injected channel send failure");
    this.sent.push(output);
  }
  public async receive(message: ChannelMessage): Promise<void> {
    if (this.#handler === undefined) throw new Error("Channel is not started");
    await this.#handler(message);
  }
}

export class FakeCredentialStore implements CredentialStore {
  readonly values = new Map<string, string>();
  public async put(reference: string, secret: string): Promise<void> { this.values.set(reference, secret); }
  public async get(reference: string): Promise<string | undefined> { return this.values.get(reference); }
  public async delete(reference: string): Promise<void> { this.values.delete(reference); }
}

export class FakeProcessRegistry implements ProcessRegistry {
  readonly stopped: string[] = [];
  public constructor(public values: RuntimeSnapshot[] = []) {}
  public async snapshots(): Promise<readonly RuntimeSnapshot[]> { return this.values; }
  public async stop(runtimeId: string): Promise<void> { this.stopped.push(runtimeId); }
}

export function openSession(id = "session-1"): AgentSession {
  return {
    id,
    projectId: "project-1",
    agentKind: "fake",
    displayName: "project · 2026-07-18",
    lastActivityAt: "2026-07-18T00:00:00.000Z",
    nativeLifecycleOwner: "AGENTLINK",
    state: "OPEN",
    runtimeState: "ALIVE",
    queuePaused: false,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z"
  };
}
