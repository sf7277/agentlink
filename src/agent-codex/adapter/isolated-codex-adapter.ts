import type {
  AgentResumeOptions,
  AgentResumeResult,
  AgentPort,
  AgentTurnRequest
} from "../../core/contracts/ports.js";
import type {
  AgentCapabilities,
  AgentSession,
  Turn
} from "../../core/domain/model.js";

export interface IsolatedAgentInstance {
  readonly agent: AgentPort;
  ownsApproval(requestId: string): boolean;
  closeRuntime(): Promise<void>;
}

export type IsolatedAgentFactory = (session: AgentSession) => Promise<IsolatedAgentInstance>;

/**
 * Local-only fallback topology. Core still sees one AgentPort and never learns
 * whether a Session uses a shared or isolated App Server.
 */
export class IsolatedCodexAdapter implements AgentPort {
  readonly #instances = new Map<string, IsolatedAgentInstance>();

  public constructor(
    private readonly factory: IsolatedAgentFactory,
    private readonly features: AgentCapabilities = {
      steering: true,
      cancellation: true,
      approvals: true
    }
  ) {}

  public capabilities(): AgentCapabilities {
    return this.features;
  }

  public async create(session: AgentSession): Promise<{
    nativeSessionId: string;
    runtimeId: string;
  }> {
    if (this.#instances.has(session.id)) throw new Error("Session Runtime already exists");
    const instance = await this.factory(session);
    this.#instances.set(session.id, instance);
    try {
      return await instance.agent.create(session);
    } catch (error) {
      this.#instances.delete(session.id);
      await instance.closeRuntime();
      throw error;
    }
  }

  public async resume(
    session: AgentSession,
    turns: readonly Turn[],
    options?: AgentResumeOptions
  ): Promise<AgentResumeResult> {
    if (this.#instances.has(session.id)) throw new Error("Session Runtime already exists");
    const instance = await this.factory(session);
    this.#instances.set(session.id, instance);
    try {
      return await instance.agent.resume(session, turns, options);
    } catch (error) {
      this.#instances.delete(session.id);
      await instance.closeRuntime();
      throw error;
    }
  }

  public sendTurn(request: AgentTurnRequest): Promise<{ nativeTurnId: string }> {
    return this.require(request.sessionId).agent.sendTurn(request);
  }

  public steer(request: AgentTurnRequest): Promise<void> {
    return this.require(request.sessionId).agent.steer(request);
  }

  public cancel(sessionId: string, turnId: string): Promise<void> {
    return this.require(sessionId).agent.cancel(sessionId, turnId);
  }

  public async close(session: AgentSession): Promise<void> {
    let instance = this.#instances.get(session.id);
    if (instance === undefined) {
      instance = await this.factory(session);
      this.#instances.set(session.id, instance);
    }
    try {
      await instance.agent.close(session);
    } finally {
      this.#instances.delete(session.id);
      await instance.closeRuntime();
    }
  }

  public async detach(session: AgentSession): Promise<void> {
    await this.withDisposableInstance(session, (agent) => agent.detach(session));
  }

  public async deleteNativeSession(session: AgentSession): Promise<void> {
    await this.withDisposableInstance(session, (agent) => agent.deleteNativeSession(session));
  }

  public resolveApproval(
    requestId: string,
    decision: "allow_once" | "deny" | "cancel"
  ): Promise<void> {
    const matches = [...this.#instances.values()].filter((instance) =>
      instance.ownsApproval(requestId)
    );
    if (matches.length !== 1) {
      throw new Error("Approval must be routed to a unique isolated Runtime");
    }
    return matches[0]!.agent.resolveApproval(requestId, decision);
  }

  public inspectApproval(requestId: string) {
    const matches = [...this.#instances.values()].filter((instance) =>
      instance.ownsApproval(requestId)
    );
    if (matches.length !== 1) {
      return Promise.resolve({ status: "unknown" as const });
    }
    return matches[0]!.agent.inspectApproval(requestId);
  }

  public runtimeCount(): number {
    return this.#instances.size;
  }

  private async withDisposableInstance(
    session: AgentSession,
    operation: (agent: AgentPort) => Promise<void>
  ): Promise<void> {
    let instance = this.#instances.get(session.id);
    if (instance === undefined) {
      instance = await this.factory(session);
      this.#instances.set(session.id, instance);
    }
    try {
      await operation(instance.agent);
    } finally {
      this.#instances.delete(session.id);
      await instance.closeRuntime();
    }
  }

  private require(sessionId: string): IsolatedAgentInstance {
    const instance = this.#instances.get(sessionId);
    if (instance === undefined) throw new Error("Session has no isolated Runtime");
    return instance;
  }
}
