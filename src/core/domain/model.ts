export type SessionId = string;
export type TurnId = string;
export type RuntimeId = string;
export type ControllerEndpointId = string;

export type SessionState = "CREATING" | "OPEN" | "CLOSING" | "CLOSED" | "UNKNOWN";
export type RuntimeState = "STARTING" | "ALIVE" | "EXITED" | "UNKNOWN";
export type TurnState =
  | "RECEIVED"
  | "QUEUED"
  | "PAUSED"
  | "DISPATCHED"
  | "RUNNING"
  | "WAITING_AGENT_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "UNKNOWN";
export type AttachmentState = "ATTACHED" | "DETACHED";
export type LeaseState = "ACTIVE" | "EXPIRED" | "REVOKED" | "CONSUMED";
export type NativeLifecycleOwner = "AGENTLINK" | "EXTERNAL";

export interface AgentCapabilities {
  readonly steering: boolean;
  readonly cancellation: boolean;
  readonly approvals: boolean;
}

export interface AgentSession {
  readonly id: SessionId;
  readonly projectId: string;
  readonly agentKind: string;
  readonly displayName: string;
  readonly lastActivityAt: string;
  readonly nativeSessionId?: string;
  readonly sourceNativeSessionId?: string;
  readonly historyTruncated?: boolean;
  readonly nativeLifecycleOwner: NativeLifecycleOwner;
  readonly runtimeId?: RuntimeId;
  readonly state: SessionState;
  readonly runtimeState: RuntimeState;
  readonly queuePaused: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GatewayUser {
  readonly id: string;
  readonly displayName: string;
}

export interface ChannelAccount {
  readonly id: string;
  readonly channelKind: string;
  readonly credentialReference?: string;
}

export interface ControllerEndpoint {
  readonly id: ControllerEndpointId;
  readonly gatewayUserId: string;
  readonly kind: string;
  readonly attachmentState: AttachmentState;
}

export interface Project {
  readonly id: string;
  readonly slug: string;
  readonly canonicalPath: string;
  readonly allowedAgents: readonly string[];
  readonly defaultAgent: string;
}

export interface ConversationBinding {
  readonly conversationId: string;
  readonly activeSessionId?: SessionId;
  readonly updatedAt: string;
}

export interface AgentRuntime {
  readonly id: RuntimeId;
  readonly state: RuntimeState;
  readonly affectedSessionIds: readonly SessionId[];
  readonly updatedAt: string;
}

export interface Turn {
  readonly id: TurnId;
  readonly sessionId: SessionId;
  readonly state: TurnState;
  readonly inputSequence: number;
  readonly queueSequence?: number;
  readonly sourceEndpointId: ControllerEndpointId;
  readonly text: string;
  readonly nativeTurnId?: string;
  readonly finalResponse?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TurnInput {
  readonly id: string;
  readonly turnId: TurnId;
  readonly inputSequence: number;
  readonly sourceEndpointId: ControllerEndpointId;
  readonly kind: "initial" | "steer";
  readonly text: string;
  readonly createdAt: string;
}

export interface AgentApprovalRequest {
  readonly id: string;
  readonly nativeRequestId: string;
  readonly nativeItemId: string;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly actionKind: string;
  readonly actionDigest: string;
  readonly summary: string;
  readonly risk: "low" | "medium" | "high";
  readonly observedAt: string;
}

export interface MobileApprovalLease {
  readonly id: string;
  readonly requestId: string;
  readonly controllerEndpointId: ControllerEndpointId;
  readonly actionDigest: string;
  readonly state: LeaseState;
  readonly expiresAt: string;
}

export type ApprovalDecision = "allow_once" | "deny" | "cancel";

export interface AgentApprovalSnapshot {
  readonly status: "pending" | "resolved" | "unknown";
  readonly nativeRequestId?: string;
  readonly actionDigest?: string;
}

export interface DomainEvent {
  readonly type: string;
  readonly occurredAt: string;
  readonly aggregateId: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface Transition<T> {
  readonly value: T;
  readonly event: DomainEvent;
}
