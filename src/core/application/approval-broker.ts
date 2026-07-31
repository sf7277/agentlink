import type {
  AgentPort,
  ApprovalLeaseEffects,
  ApprovalAuditPort,
  Clock,
  IdGenerator
} from "../contracts/ports.js";
import type {
  AgentApprovalRequest,
  ApprovalDecision,
  MobileApprovalLease
} from "../domain/model.js";
import { DomainError } from "../domain/errors.js";
import { SessionLinearizer } from "./session-linearizer.js";

interface PendingApproval {
  readonly request: AgentApprovalRequest;
  lease: MobileApprovalLease;
}

export interface ActiveMobileApproval {
  readonly request: AgentApprovalRequest;
  readonly lease: MobileApprovalLease;
}

export interface ResolveMobileApproval {
  readonly leaseId: string;
  readonly controllerEndpointId: string;
  readonly sessionId: string;
  readonly decision: ApprovalDecision;
}

export class ApprovalBroker {
  readonly #byLease = new Map<string, PendingApproval>();
  readonly #byRequest = new Map<string, PendingApproval>();
  readonly #leaseByAction = new Map<string, string>();
  readonly #requestIds = new Set<string>();
  readonly #invalidSessions = new Set<string>();
  readonly #dispatchedDecisionByTurn = new Map<string, {
    readonly sessionId: string;
    readonly decision: ApprovalDecision;
  }>();

  public constructor(
    private readonly agent: AgentPort,
    private readonly audit: ApprovalAuditPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly linearizer: SessionLinearizer,
    private readonly leaseEffects: ApprovalLeaseEffects
  ) {}

  public observe(
    request: AgentApprovalRequest,
    controllerEndpointId: string,
    leaseDurationMs: number
  ): MobileApprovalLease {
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new DomainError("approval_lease_invalid", "Approval lease duration must be positive");
    }
    if (this.#requestIds.has(request.id)) {
      throw new DomainError("approval_duplicate", "Approval request was already observed");
    }
    const actionKey = approvalActionKey(request);
    const previousLeaseId = this.#leaseByAction.get(actionKey);
    if (previousLeaseId !== undefined) {
      const previous = this.#byLease.get(previousLeaseId);
      if (previous !== undefined && previous.lease.state === "ACTIVE") {
        previous.lease = { ...previous.lease, state: "REVOKED" };
      }
    }
    const now = this.clock.now();
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) throw new Error("Clock returned an invalid timestamp");
    const lease: MobileApprovalLease = {
      id: this.ids.next("approval-short"),
      requestId: request.id,
      controllerEndpointId,
      actionDigest: request.actionDigest,
      state: "ACTIVE",
      expiresAt: new Date(nowMs + leaseDurationMs).toISOString()
    };
    this.#requestIds.add(request.id);
    const pending = { request, lease };
    this.#byLease.set(lease.id, pending);
    this.#byRequest.set(request.id, pending);
    this.#leaseByAction.set(actionKey, lease.id);
    return lease;
  }

  public async resolve(input: ResolveMobileApproval): Promise<{
    readonly status: "resolved";
    readonly turnId: string;
  }> {
    const pending = this.#byLease.get(input.leaseId);
    if (pending === undefined) {
      throw new DomainError("approval_not_pending", "Approval short ID is not active");
    }
    return this.linearizer.run(pending.request.sessionId, async () => {
      const current = this.#byLease.get(input.leaseId);
      if (current === undefined || current.lease.state !== "ACTIVE") {
        throw new DomainError("approval_already_resolved", "Approval was already resolved");
      }
      if (current.request.sessionId !== input.sessionId) {
        throw new DomainError("approval_session_mismatch", "Approval belongs to another Session");
      }
      if (current.lease.controllerEndpointId !== input.controllerEndpointId) {
        throw new DomainError("approval_controller_mismatch", "Approval belongs to another controller");
      }
      if (current.lease.actionDigest !== current.request.actionDigest) {
        current.lease = { ...current.lease, state: "REVOKED" };
        throw new DomainError("approval_digest_mismatch", "Approval action digest changed");
      }
      if (Date.parse(this.clock.now()) >= Date.parse(current.lease.expiresAt)) {
        this.leaseEffects.expireMobileWrite(
          current.request.sessionId,
          current.lease.controllerEndpointId
        );
        current.lease = { ...current.lease, state: "EXPIRED" };
        throw new DomainError("approval_expired", "Approval lease expired");
      }
      const snapshot = await this.agent.inspectApproval(current.request.id);
      if (
        snapshot.status !== "pending" ||
        snapshot.nativeRequestId !== current.request.nativeRequestId ||
        snapshot.actionDigest !== current.request.actionDigest
      ) {
        current.lease = { ...current.lease, state: "REVOKED" };
        throw new DomainError(
          "approval_native_not_pending",
          "Agent no longer confirms the same pending approval"
        );
      }

      const at = this.clock.now();
      this.audit.appendApprovalAudit({
        id: this.ids.next("approval-audit"),
        sessionId: current.request.sessionId,
        turnId: current.request.turnId,
        actionDigest: current.request.actionDigest,
        decision: input.decision,
        observedState: "decision_recorded",
        createdAt: at
      });

      current.lease = { ...current.lease, state: "CONSUMED" };
      if (this.#leaseByAction.get(approvalActionKey(current.request)) === input.leaseId) {
        this.#leaseByAction.delete(approvalActionKey(current.request));
      }
      try {
        this.#dispatchedDecisionByTurn.set(current.request.turnId, {
          sessionId: current.request.sessionId,
          decision: input.decision
        });
        await this.agent.resolveApproval(current.request.id, input.decision);
      } catch (error) {
        this.#dispatchedDecisionByTurn.delete(current.request.turnId);
        this.audit.appendApprovalAudit({
          id: this.ids.next("approval-audit"),
          sessionId: current.request.sessionId,
          turnId: current.request.turnId,
          actionDigest: current.request.actionDigest,
          decision: input.decision,
          observedState: "dispatch_uncertain",
          createdAt: this.clock.now()
        });
        throw error;
      }
      return { status: "resolved" as const, turnId: current.request.turnId };
    });
  }

  public consumeDispatchedDecision(turnId: string): ApprovalDecision | undefined {
    const dispatched = this.#dispatchedDecisionByTurn.get(turnId);
    if (dispatched === undefined) return undefined;
    this.#dispatchedDecisionByTurn.delete(turnId);
    return dispatched.decision;
  }

  public discardDispatchedDecision(turnId: string): void {
    this.#dispatchedDecisionByTurn.delete(turnId);
  }

  public lease(leaseId: string): MobileApprovalLease | undefined {
    return this.#byLease.get(leaseId)?.lease;
  }

  public activeForController(controllerEndpointId: string): readonly ActiveMobileApproval[] {
    const now = Date.parse(this.clock.now());
    return [...this.#byLease.values()]
      .filter((pending) =>
        pending.lease.controllerEndpointId === controllerEndpointId &&
        pending.lease.state === "ACTIVE" &&
        Date.parse(pending.lease.expiresAt) > now
      )
      .sort((left, right) =>
        left.request.observedAt.localeCompare(right.request.observedAt) ||
        left.lease.id.localeCompare(right.lease.id)
      )
      .map((pending) => ({ request: pending.request, lease: pending.lease }));
  }

  public async resolveForController(input: {
    readonly leaseId?: string;
    readonly controllerEndpointId: string;
    readonly decision: ApprovalDecision;
  }): Promise<{ readonly status: "resolved"; readonly turnId: string }> {
    let leaseId = input.leaseId;
    if (leaseId === undefined) {
      const active = this.activeForController(input.controllerEndpointId);
      if (active.length === 0) {
        throw new DomainError("approval_not_pending", "当前没有待审批项");
      }
      if (active.length > 1) {
        throw new DomainError("approval_ambiguous", "存在多个待审批项，请使用 /approvals 选择编号");
      }
      leaseId = active[0]!.lease.id;
    }
    const pending = this.#byLease.get(leaseId);
    if (pending === undefined) {
      throw new DomainError("approval_not_pending", "Approval short ID is not active");
    }
    return this.resolve({
      leaseId,
      decision: input.decision,
      sessionId: pending.request.sessionId,
      controllerEndpointId: input.controllerEndpointId
    });
  }

  public async expireLeases(): Promise<readonly MobileApprovalLease[]> {
    const expired: MobileApprovalLease[] = [];
    const nowMs = Date.parse(this.clock.now());
    for (const [leaseId, pending] of this.#byLease) {
      if (pending.lease.state !== "ACTIVE" || Date.parse(pending.lease.expiresAt) > nowMs) continue;
      await this.linearizer.run(pending.request.sessionId, () => {
        const current = this.#byLease.get(leaseId);
        if (
          current === undefined ||
          current.lease.state !== "ACTIVE" ||
          Date.parse(current.lease.expiresAt) > Date.parse(this.clock.now())
        ) return;
        this.leaseEffects.expireMobileWrite(
          current.request.sessionId,
          current.lease.controllerEndpointId
        );
        current.lease = { ...current.lease, state: "EXPIRED" };
        expired.push(current.lease);
      });
    }
    return expired;
  }

  public async reattach(
    sessionId: string,
    controllerEndpointId: string,
    leaseDurationMs: number
  ): Promise<MobileApprovalLease> {
    if (this.#invalidSessions.has(sessionId)) {
      throw new DomainError("approval_runtime_exited", "Runtime exited; old approval cannot be reattached");
    }
    const candidates = [...this.#byRequest.values()].filter((pending) =>
      pending.request.sessionId === sessionId &&
      pending.lease.state === "EXPIRED"
    );
    if (candidates.length !== 1) {
      throw new DomainError(
        "approval_reattach_ambiguous",
        "Reattach requires exactly one expired pending approval"
      );
    }
    const candidate = candidates[0]!;
    const snapshot = await this.agent.inspectApproval(candidate.request.id);
    if (
      snapshot.status !== "pending" ||
      snapshot.nativeRequestId !== candidate.request.nativeRequestId ||
      snapshot.actionDigest !== candidate.request.actionDigest
    ) {
      throw new DomainError(
        "approval_native_not_pending",
        "Agent does not confirm the same pending approval"
      );
    }
    return this.linearizer.run(sessionId, () => {
      const current = this.#byRequest.get(candidate.request.id);
      if (
        current === undefined ||
        current.lease.state !== "EXPIRED"
      ) {
        throw new DomainError("approval_reattach_race", "Approval changed during reattach");
      }
      this.leaseEffects.restoreMobileWrite(sessionId, controllerEndpointId);
      const lease = this.createLease(current.request, controllerEndpointId, leaseDurationMs);
      const renewed = { request: current.request, lease };
      this.#byRequest.set(current.request.id, renewed);
      this.#byLease.set(lease.id, renewed);
      this.#leaseByAction.set(approvalActionKey(current.request), lease.id);
      return lease;
    });
  }

  public async invalidateSessions(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      this.#invalidSessions.add(sessionId);
      for (const [turnId, dispatched] of this.#dispatchedDecisionByTurn) {
        if (dispatched.sessionId === sessionId) this.#dispatchedDecisionByTurn.delete(turnId);
      }
      await this.linearizer.run(sessionId, () => {
        for (const pending of this.#byRequest.values()) {
          if (pending.request.sessionId === sessionId && pending.lease.state === "ACTIVE") {
            this.leaseEffects.expireMobileWrite(
              pending.request.sessionId,
              pending.lease.controllerEndpointId
            );
            pending.lease = { ...pending.lease, state: "REVOKED" };
          }
        }
      });
    }
  }

  private createLease(
    request: AgentApprovalRequest,
    controllerEndpointId: string,
    leaseDurationMs: number
  ): MobileApprovalLease {
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new DomainError("approval_lease_invalid", "Approval lease duration must be positive");
    }
    const nowMs = Date.parse(this.clock.now());
    if (!Number.isFinite(nowMs)) throw new Error("Clock returned an invalid timestamp");
    return {
      id: this.ids.next("approval-short"),
      requestId: request.id,
      controllerEndpointId,
      actionDigest: request.actionDigest,
      state: "ACTIVE",
      expiresAt: new Date(nowMs + leaseDurationMs).toISOString()
    };
  }
}

function approvalActionKey(request: AgentApprovalRequest): string {
  return [
    request.sessionId,
    request.turnId,
    request.nativeItemId
  ].map((part) => `${part.length}:${part}`).join("|");
}
