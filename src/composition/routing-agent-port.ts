import type {
  AgentPort,
  AgentResumeOptions,
  AgentResumeResult,
  AgentTurnRequest,
  ExternalAgentSessionCandidate
} from "../core/contracts/ports.js";
import type {
  AgentApprovalSnapshot,
  AgentCapabilities,
  AgentSession,
  ApprovalDecision,
  Turn
} from "../core/domain/model.js";

/**
 * Routes AgentPort calls by session.agentKind (create/import) or remembered session map.
 */
export class RoutingAgentPort implements AgentPort {
  readonly #agents = new Map<string, AgentPort>();
  readonly #sessionKind = new Map<string, string>();

  public constructor(
    agents: Readonly<Record<string, AgentPort>>,
    private readonly resolveSessionKind?: (sessionId: string) => string | undefined
  ) {
    for (const [kind, agent] of Object.entries(agents)) {
      this.#agents.set(kind, agent);
    }
  }

  public register(kind: string, agent: AgentPort): void {
    this.#agents.set(kind, agent);
  }

  public remember(sessionId: string, agentKind: string): void {
    this.#sessionKind.set(sessionId, agentKind);
  }

  public forget(sessionId: string): void {
    this.#sessionKind.delete(sessionId);
  }

  public capabilities(sessionId?: string): AgentCapabilities {
    if (sessionId !== undefined) return this.agentForSession(sessionId).capabilities(sessionId);
    // Union of registered agents: approvals/cancellation if any support them.
    let steering = false;
    let cancellation = false;
    let approvals = false;
    for (const agent of this.#agents.values()) {
      const caps = agent.capabilities();
      steering = steering || caps.steering;
      cancellation = cancellation || caps.cancellation;
      approvals = approvals || caps.approvals;
    }
    return { steering, cancellation, approvals };
  }

  public async findMissingNativeSessions(
    sessions: readonly AgentSession[]
  ): Promise<readonly string[]> {
    const byKind = new Map<string, AgentSession[]>();
    for (const session of sessions) {
      const grouped = byKind.get(session.agentKind) ?? [];
      grouped.push(session);
      byKind.set(session.agentKind, grouped);
    }
    const missing = await Promise.all([...byKind].map(async ([kind, grouped]) => {
      const operation = this.requireKind(kind).findMissingNativeSessions;
      return operation === undefined
        ? []
        : operation.call(this.requireKind(kind), grouped);
    }));
    return missing.flat();
  }

  public forgetNativeSessions(sessions: readonly AgentSession[]): void {
    const byKind = new Map<string, AgentSession[]>();
    for (const session of sessions) {
      this.#sessionKind.delete(session.id);
      const grouped = byKind.get(session.agentKind) ?? [];
      grouped.push(session);
      byKind.set(session.agentKind, grouped);
    }
    for (const [kind, grouped] of byKind) {
      this.requireKind(kind).forgetNativeSessions?.(grouped);
    }
  }

  public async create(session: AgentSession): Promise<{ nativeSessionId: string; runtimeId: string }> {
    const result = await this.requireKind(session.agentKind).create(session);
    this.#sessionKind.set(session.id, session.agentKind);
    return result;
  }

  public discoverExternalSessions?(
    projectId: string,
    agentKind?: string
  ): Promise<readonly ExternalAgentSessionCandidate[]> {
    if (agentKind === undefined) {
      return Promise.reject(new Error("Agent kind is required for external Session discovery"));
    }
    const agent = this.requireKind(agentKind);
    if (agent.discoverExternalSessions === undefined) {
      return Promise.reject(new Error("Agent does not support external Session discovery"));
    }
    return agent.discoverExternalSessions(projectId, agentKind);
  }

  public importExternalSession?(
    session: AgentSession,
    candidate: ExternalAgentSessionCandidate
  ) {
    const agent = this.requireKind(session.agentKind);
    if (agent.importExternalSession === undefined) {
      return Promise.reject(new Error("Agent does not support external Session import"));
    }
    return agent.importExternalSession(session, candidate).then((result) => {
      this.#sessionKind.set(session.id, session.agentKind);
      return result;
    });
  }

  public rollbackExternalSessionImport?(
    session: AgentSession,
    candidate: ExternalAgentSessionCandidate
  ): Promise<void> {
    const agent = this.requireKind(session.agentKind);
    if (agent.rollbackExternalSessionImport === undefined) return Promise.resolve();
    return agent.rollbackExternalSessionImport(session, candidate);
  }

  public resume(
    session: AgentSession,
    turns: readonly Turn[],
    options?: AgentResumeOptions
  ): Promise<AgentResumeResult> {
    this.#sessionKind.set(session.id, session.agentKind);
    return this.requireKind(session.agentKind).resume(session, turns, options);
  }

  public sendTurn(request: AgentTurnRequest): Promise<{ nativeTurnId: string }> {
    return this.agentForSession(request.sessionId).sendTurn(request);
  }

  public steer(request: AgentTurnRequest): Promise<void> {
    return this.agentForSession(request.sessionId).steer(request);
  }

  public cancel(sessionId: string, turnId: string): Promise<void> {
    return this.agentForSession(sessionId).cancel(sessionId, turnId);
  }

  public close(session: AgentSession): Promise<void | "empty_session_deleted"> {
    return this.requireKind(session.agentKind).close(session).then(() => {
      this.#sessionKind.delete(session.id);
    });
  }

  public detach(session: AgentSession): Promise<void> {
    return this.requireKind(session.agentKind).detach(session).then(() => {
      this.#sessionKind.delete(session.id);
    });
  }

  public deleteNativeSession(session: AgentSession): Promise<void> {
    return this.requireKind(session.agentKind).deleteNativeSession(session).then(() => {
      this.#sessionKind.delete(session.id);
    });
  }

  public resolveApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    // Approvals are issued by one agent; try each until one accepts ownership.
    const errors: Error[] = [];
    const attempts = [...this.#agents.values()].map(async (agent) => {
      try {
        await agent.resolveApproval(requestId, decision);
        return true;
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
        return false;
      }
    });
    return Promise.all(attempts).then((results) => {
      if (results.some(Boolean)) return;
      throw errors[0] ?? new Error("Approval request is no longer pending");
    });
  }

  public inspectApproval(requestId: string): Promise<AgentApprovalSnapshot> {
    return (async () => {
      for (const agent of this.#agents.values()) {
        const snapshot = await agent.inspectApproval(requestId);
        if (snapshot.status === "pending" || snapshot.status === "unknown") return snapshot;
      }
      return { status: "resolved" as const };
    })();
  }

  private agentForSession(sessionId: string): AgentPort {
    const kind = this.#sessionKind.get(sessionId) ?? this.resolveSessionKind?.(sessionId);
    if (kind === undefined) throw new Error(`No agent mapping for session ${sessionId}`);
    return this.requireKind(kind);
  }

  private requireKind(kind: string): AgentPort {
    const agent = this.#agents.get(kind);
    if (agent === undefined) throw new Error(`Agent kind is not configured: ${kind}`);
    return agent;
  }
}
