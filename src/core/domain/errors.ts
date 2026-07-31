export class DomainError extends Error {
  public constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export class InvalidTransitionError extends DomainError {
  public constructor(entity: string, from: string, to: string) {
    super("invalid_transition", `${entity} cannot transition from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export class QueueFullError extends DomainError {
  public constructor(limit: number) {
    super("queue_full", `Session queue reached its limit of ${limit}`);
    this.name = "QueueFullError";
  }
}

export class AgentOperationUncertainError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentOperationUncertainError";
  }
}

export class AgentAuthenticationRequiredError extends DomainError {
  public constructor(agentName: string, loginCommand: string) {
    super(
      "agent_authentication_required",
      `${agentName}认证已失效，请在本机执行 ${loginCommand} 后重试`
    );
    this.name = "AgentAuthenticationRequiredError";
  }
}
