/**
 * Thin contract between the Claude adapter and the Claude Agent SDK.
 *
 * The adapter uses this interface plus a fake for contract tests; the real
 * binding is backed by @anthropic-ai/claude-agent-sdk. The adapter only
 * depends on this module so the SDK can be replaced or upgraded in one place.
 */

export class ClaudeSdkAuthenticationRequiredError extends Error {
  public constructor(message = "Claude Code authentication is required") {
    super(message);
    this.name = "ClaudeSdkAuthenticationRequiredError";
  }
}

export interface ClaudeSdkPermissionRequest {
  readonly nativeSessionId: string;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly toolInput: unknown;
  /** Resolves the SDK canUseTool callback. Must be called exactly once. */
  respond(decision: "allow" | "deny", message?: string): void;
}

export interface ClaudeSdkTurnResult {
  readonly status: "completed" | "interrupted" | "failed";
  readonly finalResponse?: string;
}

export interface ClaudeSdkSessionEvents {
  permissionRequested(request: ClaudeSdkPermissionRequest): void;
  /** Fired on unexpected subprocess/stream death; never fired by end(). */
  exited(error: Error): void;
}

export interface ClaudeSdkSessionHandle {
  readonly nativeSessionId: string;
  /** Submits one user turn; resolves when the turn reaches a terminal state. */
  prompt(text: string): Promise<ClaudeSdkTurnResult>;
  interrupt(): Promise<void>;
  /** Disposes the handle and its subprocess without touching session files. */
  end(): Promise<void>;
}

export interface ClaudeSdkStartOptions {
  readonly cwd: string;
  readonly resumeNativeSessionId?: string;
  readonly events: ClaudeSdkSessionEvents;
}

export interface ClaudeSdkSessionSummary {
  readonly nativeSessionId: string;
  readonly title: string;
  readonly lastModifiedMs: number;
  /** The session's own recorded cwd, used to verify project identity. */
  readonly cwd?: string;
}

export interface ClaudeSdkClient {
  startSession(options: ClaudeSdkStartOptions): Promise<ClaudeSdkSessionHandle>;
  /** Lists native sessions recorded for one project directory. */
  listSessions(options: { cwd: string; limit: number }): Promise<readonly ClaudeSdkSessionSummary[]>;
  close(): Promise<void>;
}
