import {
  ClaudeSdkAuthenticationRequiredError,
  type ClaudeSdkClient,
  type ClaudeSdkPermissionRequest,
  type ClaudeSdkSessionEvents,
  type ClaudeSdkSessionHandle,
  type ClaudeSdkSessionSummary,
  type ClaudeSdkStartOptions,
  type ClaudeSdkTurnResult
} from "../../src/agent-claude/sdk/claude-sdk-client.js";

export class FakeClaudeSdkSession implements ClaudeSdkSessionHandle {
  readonly prompts: string[] = [];
  interrupts = 0;
  ended = false;
  #interruptCurrent: (() => void) | undefined;

  public constructor(
    public readonly nativeSessionId: string,
    private readonly events: ClaudeSdkSessionEvents,
    private readonly owner: FakeClaudeSdkClient
  ) {}

  public async prompt(text: string): Promise<ClaudeSdkTurnResult> {
    this.prompts.push(text);
    this.owner.promptedTexts.push(text);
    if (this.owner.promptError !== undefined) {
      const error = this.owner.promptError;
      this.owner.promptError = undefined;
      throw error;
    }
    let interrupted = false;
    const interruptible = new Promise<void>((resolve) => {
      this.#interruptCurrent = () => {
        interrupted = true;
        resolve();
      };
    });
    if (this.owner.permissionMode === "request") {
      const decision = await Promise.race([
        new Promise<"allow" | "deny">((resolve) => {
          const request: ClaudeSdkPermissionRequest = {
            nativeSessionId: this.nativeSessionId,
            toolUseId: `toolu-${this.owner.nextToolUse++}`,
            toolName: this.owner.permissionToolName,
            toolInput: this.owner.permissionToolInput,
            respond: (value) => resolve(value)
          };
          this.events.permissionRequested(request);
        }),
        interruptible.then(() => "interrupted" as const)
      ]);
      if (decision === "allow") {
        this.#interruptCurrent = undefined;
        return { status: "completed", finalResponse: "after-permission:allow" };
      }
      // Real SDK semantics: denying one tool call does NOT end the turn — the
      // model keeps working until it finishes or the turn is interrupted.
      await interruptible;
      this.#interruptCurrent = undefined;
      return interrupted
        ? { status: "interrupted" }
        : { status: "completed", finalResponse: "after-permission:deny" };
    }
    if (this.owner.promptDelayMs > 0) {
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, this.owner.promptDelayMs)),
        interruptible
      ]);
    }
    this.#interruptCurrent = undefined;
    if (interrupted) return { status: "interrupted" };
    return { status: "completed", finalResponse: `echo:${text}` };
  }

  public async interrupt(): Promise<void> {
    this.interrupts += 1;
    this.owner.interrupted.push(this.nativeSessionId);
    this.#interruptCurrent?.();
  }

  public async end(): Promise<void> {
    this.ended = true;
  }

  public emitExit(error: Error): void {
    this.events.exited(error);
  }
}

export class FakeClaudeSdkClient implements ClaudeSdkClient {
  readonly started: { cwd: string; resumeNativeSessionId?: string }[] = [];
  readonly sessions: FakeClaudeSdkSession[] = [];
  readonly promptedTexts: string[] = [];
  readonly interrupted: string[] = [];
  authRequired = false;
  promptError: Error | undefined;
  promptDelayMs = 0;
  permissionMode: "none" | "request" = "none";
  permissionToolName = "Bash";
  permissionToolInput: unknown = { command: "echo hi" };
  nextToolUse = 1;
  /** Native sessions reported by listSessions discovery. */
  discoverable: ClaudeSdkSessionSummary[] = [];
  readonly listedDirectories: { cwd: string; limit: number }[] = [];
  #nextSession = 1;

  public async startSession(options: ClaudeSdkStartOptions): Promise<ClaudeSdkSessionHandle> {
    if (this.authRequired) {
      throw new ClaudeSdkAuthenticationRequiredError();
    }
    this.started.push({
      cwd: options.cwd,
      ...(options.resumeNativeSessionId === undefined
        ? {}
        : { resumeNativeSessionId: options.resumeNativeSessionId })
    });
    const nativeSessionId = options.resumeNativeSessionId ??
      `0e0e0e0e-0000-4000-8000-${String(this.#nextSession++).padStart(12, "0")}`;
    const session = new FakeClaudeSdkSession(nativeSessionId, options.events, this);
    this.sessions.push(session);
    return session;
  }

  public async listSessions(options: {
    cwd: string;
    limit: number;
  }): Promise<readonly ClaudeSdkSessionSummary[]> {
    this.listedDirectories.push(options);
    return this.discoverable.slice(0, options.limit);
  }

  public async close(): Promise<void> {}
}
