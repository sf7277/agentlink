import type {
  ApprovalDecision,
  AgentApprovalSnapshot,
  AgentCapabilities,
  AgentSession,
  SessionId,
  Turn,
  TurnId
} from "../domain/model.js";

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(prefix: string): string;
}

export interface DigestService {
  digest(parts: readonly string[]): string;
}

export interface ChannelMessage {
  readonly eventId: string;
  readonly accountId: string;
  readonly senderId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly text?: string;
  readonly receivedAt: string;
}

export interface ChannelOutput {
  readonly conversationId: string;
  readonly text: string;
  readonly replyTo?: string;
}

export interface ChannelPort {
  start(onMessage: (message: ChannelMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  send(output: ChannelOutput): Promise<void>;
}

export interface AgentTurnRequest {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly text: string;
}

export interface AgentResumeResult {
  readonly runtimeId: string;
  readonly displayName?: string;
  readonly reconciledTurns: readonly {
    readonly turnId: TurnId;
    readonly state: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "UNKNOWN";
  }[];
}

export interface AgentResumeOptions {
  readonly reopenClosed: boolean;
}

export interface ExternalAgentSessionCandidate {
  readonly nativeSessionId: string;
  readonly displayName: string;
  readonly lastActivityAt: string;
  readonly archived: boolean;
}

export interface AgentImportResult {
  readonly nativeSessionId: string;
  readonly sourceNativeSessionId: string;
  readonly nativeLifecycleOwner: AgentSession["nativeLifecycleOwner"];
  readonly historyTruncated: boolean;
  readonly runtimeId: string;
  readonly displayName: string;
  readonly lastActivityAt: string;
}

export interface AgentPort {
  capabilities(sessionId?: SessionId): AgentCapabilities;
  /**
   * Returns AgentLink Session IDs whose persisted native Session no longer
   * exists. Persistent adapters implement this so external native deletion is
   * reflected back into the control plane before another mobile operation.
   */
  findMissingNativeSessions?(
    sessions: readonly AgentSession[]
  ): Promise<readonly SessionId[]>;
  forgetNativeSessions?(sessions: readonly AgentSession[]): void;
  create(session: AgentSession): Promise<{ nativeSessionId: string; runtimeId: string }>;
  discoverExternalSessions?(
    projectId: string,
    agentKind?: string
  ): Promise<readonly ExternalAgentSessionCandidate[]>;
  importExternalSession?(
    session: AgentSession,
    candidate: ExternalAgentSessionCandidate
  ): Promise<AgentImportResult>;
  rollbackExternalSessionImport?(
    session: AgentSession,
    candidate: ExternalAgentSessionCandidate
  ): Promise<void>;
  resume(
    session: AgentSession,
    turns: readonly Turn[],
    options?: AgentResumeOptions
  ): Promise<AgentResumeResult>;
  sendTurn(request: AgentTurnRequest): Promise<{ nativeTurnId: string }>;
  steer(request: AgentTurnRequest): Promise<void>;
  cancel(sessionId: SessionId, turnId: TurnId): Promise<void>;
  close(session: AgentSession): Promise<void | "empty_session_deleted">;
  detach(session: AgentSession): Promise<void>;
  deleteNativeSession(session: AgentSession): Promise<void>;
  resolveApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
  inspectApproval(requestId: string): Promise<AgentApprovalSnapshot>;
}

export interface ApprovalLeaseEffects {
  expireMobileWrite(sessionId: string, controllerEndpointId: string): void;
  restoreMobileWrite(sessionId: string, controllerEndpointId: string): void;
}

export interface ControllerInputGate {
  assertCanSubmit(sessionId: string, controllerEndpointId: string): void;
}

export interface TurnAdmissionGate {
  assertCanStartTurn(sessionId: string, controllerEndpointId: string): void;
}

export interface ApprovalAuditRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly actionDigest: string;
  readonly decision?: ApprovalDecision;
  readonly observedState: string;
  readonly createdAt: string;
}

export interface ApprovalAuditPort {
  appendApprovalAudit(record: ApprovalAuditRecord): void;
}

export interface RuntimeSnapshot {
  readonly runtimeId: string;
  readonly alive: boolean;
  readonly affectedSessionIds: readonly SessionId[];
}

export interface ProcessRegistry {
  snapshots(): Promise<readonly RuntimeSnapshot[]>;
  stop(runtimeId: string): Promise<void>;
}

export interface CredentialStore {
  put(reference: string, secret: string): Promise<void>;
  get(reference: string): Promise<string | undefined>;
  delete(reference: string): Promise<void>;
}

export interface Transaction {
  getSession(id: SessionId): AgentSession | undefined;
  putSession(session: AgentSession): void;
  deleteSession(id: SessionId): void;
  getTurn(id: TurnId): Turn | undefined;
  putTurn(turn: Turn): void;
  listTurns(sessionId: SessionId): readonly Turn[];
  nextInputSequence(sessionId: SessionId): number;
  nextQueueSequence(sessionId: SessionId): number;
}

export interface StateStore {
  transaction<T>(operation: (transaction: Transaction) => T): T;
  reconcileStartup(now: string): void;
  acceptMessageAndTurn?(
    accountId: string,
    messageId: string,
    receivedAt: string,
    turn: Turn
  ): boolean;
}

export interface LocalTurnControlEvent {
  readonly endpointId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly kind: "input" | "steer" | "stop" | "close";
}

export type LocalControlEvent =
  | LocalTurnControlEvent
  | {
      readonly endpointId: string;
      readonly kind: "session_discover";
      readonly project: string;
      readonly agent?: string | undefined;
    }
  | {
      readonly endpointId: string;
      readonly kind: "session_import";
      readonly project: string;
      readonly reference: string;
      readonly agent?: string | undefined;
    }
  | {
      readonly endpointId: string;
      readonly kind: "session_list";
      readonly project?: string | undefined;
      readonly scope: "active" | "archived" | "all";
    }
  | {
      readonly endpointId: string;
      readonly kind: "session_show" | "session_archive" | "session_unarchive" |
        "session_delete" | "session_detach";
      readonly sessionId: string;
    }
  | {
      readonly endpointId: string;
      readonly kind: "project_disable" | "project_enable" | "project_remove";
      readonly project: string;
    }
  | {
      readonly endpointId: string;
      readonly kind: "channel_status" | "channel_disconnect";
      readonly channel: "wechat";
    };

export interface LocalControlPort {
  start(onEvent: (event: LocalControlEvent) => Promise<unknown>): Promise<void>;
  stop(): Promise<void>;
  publish(sessionId: string, payload: Readonly<Record<string, unknown>>): void;
}
