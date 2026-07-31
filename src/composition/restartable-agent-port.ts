import type {
  AgentResumeOptions,
  AgentResumeResult,
  AgentPort,
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

export class RestartableAgentPort implements AgentPort {
  #current: AgentPort | undefined;

  public constructor(private readonly advertisedCapabilities: AgentCapabilities) {}

  public install(agent: AgentPort): void {
    this.#current = agent;
  }

  public clear(): void {
    this.#current = undefined;
  }

  public available(): boolean {
    return this.#current !== undefined;
  }

  public capabilities(sessionId?: string): AgentCapabilities {
    return this.#current?.capabilities(sessionId) ?? this.advertisedCapabilities;
  }

  public findMissingNativeSessions(
    sessions: readonly AgentSession[]
  ): Promise<readonly string[]> {
    const current = this.requireCurrent();
    return current.findMissingNativeSessions?.(sessions) ?? Promise.resolve([]);
  }

  public forgetNativeSessions(sessions: readonly AgentSession[]): void {
    this.#current?.forgetNativeSessions?.(sessions);
  }

  public create(session: AgentSession): Promise<{ nativeSessionId: string; runtimeId: string }> {
    return this.requireCurrent().create(session);
  }

  public discoverExternalSessions(
    projectId: string,
    agentKind?: string
  ): Promise<readonly ExternalAgentSessionCandidate[]> {
    const current = this.requireCurrent();
    const operation = current.discoverExternalSessions;
    if (operation === undefined) throw new Error("Agent does not support external Session discovery");
    return operation.call(current, projectId, agentKind);
  }

  public importExternalSession(
    session: AgentSession,
    candidate: ExternalAgentSessionCandidate
  ) {
    const current = this.requireCurrent();
    const operation = current.importExternalSession;
    if (operation === undefined) throw new Error("Agent does not support external Session import");
    return operation.call(current, session, candidate);
  }

  public rollbackExternalSessionImport(
    session: AgentSession,
    candidate: ExternalAgentSessionCandidate
  ): Promise<void> {
    const current = this.requireCurrent();
    const operation = current.rollbackExternalSessionImport;
    if (operation === undefined) return Promise.resolve();
    return operation.call(current, session, candidate);
  }

  public resume(
    session: AgentSession,
    turns: readonly Turn[],
    options?: AgentResumeOptions
  ): Promise<AgentResumeResult> {
    return this.requireCurrent().resume(session, turns, options);
  }

  public sendTurn(request: AgentTurnRequest): Promise<{ nativeTurnId: string }> {
    return this.requireCurrent().sendTurn(request);
  }

  public steer(request: AgentTurnRequest): Promise<void> {
    return this.requireCurrent().steer(request);
  }

  public cancel(sessionId: string, turnId: string): Promise<void> {
    return this.requireCurrent().cancel(sessionId, turnId);
  }

  public close(session: AgentSession): Promise<void | "empty_session_deleted"> {
    return this.requireCurrent().close(session);
  }

  public detach(session: AgentSession): Promise<void> {
    return this.requireCurrent().detach(session);
  }

  public deleteNativeSession(session: AgentSession): Promise<void> {
    return this.requireCurrent().deleteNativeSession(session);
  }

  public resolveApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    return this.requireCurrent().resolveApproval(requestId, decision);
  }

  public inspectApproval(requestId: string): Promise<AgentApprovalSnapshot> {
    return this.requireCurrent().inspectApproval(requestId);
  }

  private requireCurrent(): AgentPort {
    if (this.#current === undefined) {
      throw new Error("Codex Runtime is restarting; retry after it becomes ready");
    }
    return this.#current;
  }
}
