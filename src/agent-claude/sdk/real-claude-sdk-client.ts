import {
  AbortError,
  listSessions,
  query,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeSdkAuthenticationRequiredError,
  type ClaudeSdkClient,
  type ClaudeSdkSessionEvents,
  type ClaudeSdkSessionHandle,
  type ClaudeSdkSessionSummary,
  type ClaudeSdkStartOptions,
  type ClaudeSdkTurnResult
} from "./claude-sdk-client.js";

/**
 * Real binding to @anthropic-ai/claude-agent-sdk (exact version pinned in
 * package.json; the SDK ships its own claude CLI binary).
 *
 * Configuration posture (ADR 0007 / 0008):
 * - Omit settingSources and permissionMode so the user's Claude CLI applies
 *   its normal user/project configuration, hooks and effective policy.
 * - canUseTool is only called for requests which remain pending after that
 *   native policy; it supplies a one-time mobile decision without changing
 *   the policy itself.
 * - The subprocess receives a deliberately limited environment. Interactive
 *   shell-only credentials are not emulated; persistent Claude configuration
 *   remains the supported inheritance path.
 * - This module never reads, writes or logs credentials.
 */

const AUTHENTICATION_ERROR_PATTERN =
  /authentication_failed|invalid api key|please run \/login|oauth token (has )?expired|not logged in/iu;

export interface RealClaudeSdkClientOptions {
  /** Explicit subprocess environment; defaults to the minimal allowlist. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly initializeTimeoutMs?: number;
  /**
   * Absolute path to the user's own Claude Code CLI. Required: AgentLink runs
   * the same binary the user's TUI runs so credential handling can never
   * diverge, and so releases do not ship a second 245MB CLI copy. The version
   * gate in ../protocol/version-gate.ts guards protocol compatibility.
   */
  readonly claudeExecutablePath: string;
}

/**
 * Deliberately small subprocess environment. USER is required: without it
 * the CLI cannot locate the login keychain and reports "Not logged in" even
 * though the credentials exist (verified by probe, task18 Phase B).
 *
 * Authentication/environment selection is intentionally not copied from an
 * interactive shell. The CLI's persistent user/project settings are inherited
 * through the omitted settingSources option below.
 */
export function allowedClaudeEnvironment(): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "",
    TMPDIR: process.env["TMPDIR"] ?? "/tmp",
    USER: process.env["USER"] ?? ""
  };
}

export class RealClaudeSdkClient implements ClaudeSdkClient {
  readonly #live = new Set<RealClaudeSdkSession>();

  public constructor(private readonly options: RealClaudeSdkClientOptions) {}

  public async startSession(start: ClaudeSdkStartOptions): Promise<ClaudeSdkSessionHandle> {
    const session = new RealClaudeSdkSession(start, {
      environment: this.options.environment ?? allowedClaudeEnvironment(),
      initializeTimeoutMs: this.options.initializeTimeoutMs ?? 60_000,
      claudeExecutablePath: this.options.claudeExecutablePath,
      onDisposed: (disposed) => this.#live.delete(disposed)
    });
    this.#live.add(session);
    try {
      await session.waitForInit();
    } catch (error) {
      this.#live.delete(session);
      await session.end().catch(() => undefined);
      throw error;
    }
    return session;
  }

  public async listSessions(options: {
    cwd: string;
    limit: number;
  }): Promise<readonly ClaudeSdkSessionSummary[]> {
    const sessions = await listSessions({
      dir: options.cwd,
      limit: options.limit,
      // Sibling git worktrees are separate Projects in AgentLink's registry, so
      // their sessions must not appear as candidates for this one.
      includeWorktrees: false
    });
    return sessions.map((session) => ({
      nativeSessionId: session.sessionId,
      title: session.customTitle ?? session.summary,
      lastModifiedMs: session.lastModified,
      ...(session.cwd === undefined ? {} : { cwd: session.cwd })
    }));
  }

  /** Terminates every live session subprocess; used on shutdown and restart. */
  public async close(): Promise<void> {
    const sessions = [...this.#live];
    this.#live.clear();
    await Promise.all(sessions.map((session) => session.end().catch(() => undefined)));
  }
}

interface PendingResult {
  resolve(result: ClaudeSdkTurnResult): void;
  reject(error: Error): void;
}

class RealClaudeSdkSession implements ClaudeSdkSessionHandle {
  #nativeSessionId: string | undefined;
  #initResolve: (() => void) | undefined;
  #initReject: ((error: Error) => void) | undefined;
  readonly #initPromise: Promise<void>;
  readonly #input = new PushableStream<SDKUserMessage>();
  readonly #abort = new AbortController();
  readonly #query: Query;
  readonly #events: ClaudeSdkSessionEvents;
  #pending: PendingResult | undefined;
  #interruptRequested = false;
  #ended = false;
  #lastAssistantError: string | undefined;
  /**
   * The priming message produces its own `result`. It can land after the first
   * real prompt is submitted, so it must be consumed by count rather than by
   * "is a turn pending" — otherwise it would resolve a real turn with no text.
   */
  #unconsumedPrimingResults = 1;

  readonly #onDisposed: (session: RealClaudeSdkSession) => void;

  public constructor(
    start: ClaudeSdkStartOptions,
    runtime: {
      environment: Record<string, string>;
      initializeTimeoutMs: number;
      claudeExecutablePath: string;
      onDisposed: (session: RealClaudeSdkSession) => void;
    }
  ) {
    this.#events = start.events;
    this.#onDisposed = runtime.onDisposed;
    this.#initPromise = new Promise<void>((resolve, reject) => {
      this.#initResolve = resolve;
      this.#initReject = reject;
      const timer = setTimeout(() => {
        reject(new Error("Claude SDK session did not initialize in time"));
      }, runtime.initializeTimeoutMs);
      timer.unref?.();
    });
    const options: Options = {
      cwd: start.cwd,
      abortController: this.#abort,
      env: runtime.environment,
      // Run the user's own CLI rather than the SDK's bundled copy.
      pathToClaudeCodeExecutable: runtime.claudeExecutablePath,
      canUseTool: (toolName, toolInput, meta) =>
        this.handleCanUseTool(toolName, toolInput, meta.toolUseID),
      ...(start.resumeNativeSessionId === undefined
        ? {}
        : { resume: start.resumeNativeSessionId })
    };
    this.#query = query({ prompt: this.#input, options });
    void this.pump();
    // The CLI only emits system/init once the input stream yields its first
    // message. Prime with an empty non-querying message so the session id
    // exists before the first real turn, without an assistant turn and
    // without polluting the model's context (verified, task18 Phase B).
    this.#input.push({
      type: "user",
      message: { role: "user", content: "" },
      parent_tool_use_id: null,
      shouldQuery: false
    });
  }

  public get nativeSessionId(): string {
    if (this.#nativeSessionId === undefined) {
      throw new Error("Claude SDK session is not initialized yet");
    }
    return this.#nativeSessionId;
  }

  public async waitForInit(): Promise<void> {
    await this.#initPromise;
  }

  public async prompt(text: string): Promise<ClaudeSdkTurnResult> {
    if (this.#pending !== undefined) {
      throw new Error("Claude SDK session already has an active prompt");
    }
    if (this.#ended) throw new Error("Claude SDK session has ended");
    this.#interruptRequested = false;
    this.#lastAssistantError = undefined;
    const result = new Promise<ClaudeSdkTurnResult>((resolve, reject) => {
      this.#pending = { resolve, reject };
    });
    this.#input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null
    });
    return result;
  }

  public async interrupt(): Promise<void> {
    this.#interruptRequested = true;
    await this.#query.interrupt();
  }

  public async end(): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    this.#onDisposed(this);
    this.#input.end();
    this.#abort.abort();
    this.#pending?.reject(new Error("Claude SDK session has ended"));
    this.#pending = undefined;
  }

  private async pump(): Promise<void> {
    try {
      for await (const message of this.#query) {
        this.route(message);
      }
      this.finish(new Error("Claude SDK stream ended"));
    } catch (error) {
      this.finish(this.normalizeError(error));
    }
  }

  private route(message: SDKMessage): void {
    if (message.type === "system" && message.subtype === "init") {
      this.#nativeSessionId = message.session_id;
      this.#initResolve?.();
      this.#initResolve = undefined;
      this.#initReject = undefined;
      return;
    }
    if (message.type === "assistant" && message.error !== undefined) {
      this.#lastAssistantError = message.error;
      return;
    }
    if (message.type === "result") {
      if (this.#unconsumedPrimingResults > 0) {
        this.#unconsumedPrimingResults -= 1;
        return;
      }
      const pending = this.#pending;
      this.#pending = undefined;
      if (pending === undefined) return;
      if (this.#lastAssistantError === "authentication_failed") {
        pending.reject(new ClaudeSdkAuthenticationRequiredError());
        return;
      }
      pending.resolve(this.mapResult(message));
    }
  }

  private mapResult(message: SDKResultMessage): ClaudeSdkTurnResult {
    if (this.#interruptRequested) return { status: "interrupted" };
    if (message.subtype === "success") {
      if (message.is_error) {
        return {
          status: "failed",
          ...(message.result === "" ? {} : { finalResponse: message.result })
        };
      }
      return { status: "completed", finalResponse: message.result };
    }
    return {
      status: "failed",
      ...(message.errors.length === 0
        ? {}
        : { finalResponse: message.errors.join("; ").slice(0, 2_000) })
    };
  }

  private async handleCanUseTool(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string
  ): Promise<PermissionResult> {
    if (this.#nativeSessionId === undefined) {
      return { behavior: "deny", message: "AgentLink session is not ready" };
    }
    return new Promise<PermissionResult>((resolve) => {
      let responded = false;
      this.#events.permissionRequested({
        nativeSessionId: this.#nativeSessionId!,
        toolUseId,
        toolName,
        toolInput,
        respond: (decision, message) => {
          if (responded) return;
          responded = true;
          resolve(decision === "allow"
            ? { behavior: "allow", updatedInput: toolInput }
            : { behavior: "deny", message: message ?? "AgentLink denied the tool call" });
        }
      });
    });
  }

  private normalizeError(error: unknown): Error {
    if (error instanceof AbortError) return new Error("Claude SDK session aborted");
    if (error instanceof Error) {
      if (AUTHENTICATION_ERROR_PATTERN.test(error.message)) {
        return new ClaudeSdkAuthenticationRequiredError(error.message);
      }
      return error;
    }
    return new Error(String(error));
  }

  private finish(error: Error): void {
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.reject(error);
    if (this.#initReject !== undefined) {
      const rejectInit = this.#initReject;
      this.#initResolve = undefined;
      this.#initReject = undefined;
      rejectInit(error);
      return;
    }
    if (this.#ended) return;
    this.#ended = true;
    this.#onDisposed(this);
    this.#events.exited(error);
  }
}

class PushableStream<T> implements AsyncIterable<T> {
  readonly #queue: T[] = [];
  readonly #waiters: ((result: IteratorResult<T>) => void)[] = [];
  #done = false;

  public push(value: T): void {
    if (this.#done) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ value, done: false });
      return;
    }
    this.#queue.push(value);
  }

  public end(): void {
    if (this.#done) return;
    this.#done = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.#queue.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
      return: (): Promise<IteratorResult<T>> => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      }
    };
  }
}
