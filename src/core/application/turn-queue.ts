import type {
  AgentPort,
  Clock,
  ControllerInputGate,
  IdGenerator,
  StateStore,
  Transaction,
  TurnAdmissionGate
} from "../contracts/ports.js";
import { DomainError, QueueFullError } from "../domain/errors.js";
import { isTerminalTurn, transitionSession, transitionTurn } from "../domain/transitions.js";
import type { SessionId, Turn } from "../domain/model.js";
import { SessionLinearizer } from "./session-linearizer.js";

const activeStates = new Set(["DISPATCHED", "RUNNING", "WAITING_AGENT_APPROVAL"]);

export type RecoveredQueueDisposition =
  | { readonly kind: "ready" }
  | { readonly kind: "active"; readonly turn: Turn }
  | { readonly kind: "paused"; readonly count: number }
  | { readonly kind: "unknown" };

export interface ChannelMessageReceipt {
  readonly accountId: string;
  readonly messageId: string;
  readonly receivedAt: string;
}

export class TurnQueue {
  public constructor(
    private readonly store: StateStore,
    private readonly agent: AgentPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly linearizer: SessionLinearizer,
    private readonly queueLimit = 32,
    private readonly inputGate?: ControllerInputGate,
    private readonly admissionGate?: TurnAdmissionGate
  ) {}

  public async enqueue(sessionId: SessionId, sourceEndpointId: string, text: string): Promise<Turn> {
    this.admissionGate?.assertCanStartTurn(sessionId, sourceEndpointId);
    this.inputGate?.assertCanSubmit(sessionId, sourceEndpointId);
    const { created, candidate } = await this.linearizer.run(sessionId, () => {
      const created = this.store.transaction((transaction) => {
        const session = transaction.getSession(sessionId);
        if (session?.state !== "OPEN") throw new DomainError("session_not_open", "Session is not open");
        const turns = transaction.listTurns(sessionId);
        const queued = turns.filter((turn) => turn.state === "QUEUED" || turn.state === "PAUSED");
        if (queued.length >= this.queueLimit) throw new QueueFullError(this.queueLimit);
        const now = this.clock.now();
        const received: Turn = {
          id: this.ids.next("turn"),
          sessionId,
          sourceEndpointId,
          text,
          state: "RECEIVED",
          inputSequence: transaction.nextInputSequence(sessionId),
          queueSequence: transaction.nextQueueSequence(sessionId),
          createdAt: now,
          updatedAt: now
        };
        const initialState =
          session.queuePaused || turns.some((turn) => turn.state === "UNKNOWN") ? "PAUSED" : "QUEUED";
        const queuedTurn = transitionTurn(received, initialState, now).value;
        transaction.putTurn(queuedTurn);
        transaction.putSession({ ...session, lastActivityAt: now });
        return queuedTurn;
      });
      return { created, candidate: this.takeNextLocked(sessionId) };
    });
    await this.dispatch(candidate);
    return this.store.transaction((transaction) => transaction.getTurn(created.id)) ?? created;
  }

  /**
   * Persist a mobile receipt and its Turn together. If the platform retries a
   * previously accepted message, no second Turn is created.
   */
  public async enqueueChannelMessage(
    sessionId: SessionId,
    sourceEndpointId: string,
    text: string,
    receipt: ChannelMessageReceipt
  ): Promise<Turn | undefined> {
    const accept = this.store.acceptMessageAndTurn;
    if (accept === undefined) {
      throw new Error("State store does not support atomic channel receipt admission");
    }
    this.admissionGate?.assertCanStartTurn(sessionId, sourceEndpointId);
    this.inputGate?.assertCanSubmit(sessionId, sourceEndpointId);
    const { created, candidate, accepted } = await this.linearizer.run(sessionId, () => {
      const created = this.store.transaction((transaction) => {
        const session = transaction.getSession(sessionId);
        if (session?.state !== "OPEN") throw new DomainError("session_not_open", "Session is not open");
        const turns = transaction.listTurns(sessionId);
        const queued = turns.filter((turn) => turn.state === "QUEUED" || turn.state === "PAUSED");
        if (queued.length >= this.queueLimit) throw new QueueFullError(this.queueLimit);
        const now = this.clock.now();
        const received: Turn = {
          id: this.ids.next("turn"),
          sessionId,
          sourceEndpointId,
          text,
          state: "RECEIVED",
          inputSequence: transaction.nextInputSequence(sessionId),
          queueSequence: transaction.nextQueueSequence(sessionId),
          createdAt: now,
          updatedAt: now
        };
        const initialState =
          session.queuePaused || turns.some((turn) => turn.state === "UNKNOWN") ? "PAUSED" : "QUEUED";
        return transitionTurn(received, initialState, now).value;
      });
      const accepted = accept.call(
        this.store,
        receipt.accountId,
        receipt.messageId,
        receipt.receivedAt,
        created
      );
      if (!accepted) return { created, accepted, candidate: undefined };
      const candidate = this.store.transaction((transaction) => {
        const session = transaction.getSession(sessionId);
        if (session !== undefined) {
          transaction.putSession({ ...session, lastActivityAt: this.clock.now() });
        }
        return this.takeNextLocked(sessionId);
      });
      return { created, accepted, candidate };
    });
    await this.dispatch(candidate);
    if (!accepted) return undefined;
    return this.store.transaction((transaction) => transaction.getTurn(created.id)) ?? created;
  }

  public async complete(turnId: string, finalResponse: string): Promise<void> {
    const sessionId = this.store.transaction((tx) => tx.getTurn(turnId)?.sessionId);
    if (sessionId === undefined) throw new DomainError("turn_not_found", "Turn was not found");
    const candidate = await this.linearizer.run(sessionId, () => {
      this.store.transaction((transaction) => {
        const turn = transaction.getTurn(turnId);
        if (turn === undefined) throw new DomainError("turn_not_found", "Turn was not found");
        if (isTerminalTurn(turn.state)) return;
        const now = this.clock.now();
        const completed = transitionTurn(turn, "COMPLETED", now).value;
        transaction.putTurn({ ...completed, finalResponse });
        const session = transaction.getSession(sessionId);
        if (session !== undefined) transaction.putSession({ ...session, lastActivityAt: now });
      });
      return this.takeNextLocked(sessionId);
    });
    await this.dispatch(candidate);
  }

  /**
   * The App Server may notify turn/started before turn/start resolves.  Accept
   * that ordering so the dispatch completion path becomes an idempotent no-op.
   */
  public async started(turnId: string, nativeTurnId: string): Promise<void> {
    const sessionId = this.store.transaction((tx) => tx.getTurn(turnId)?.sessionId);
    if (sessionId === undefined) return;
    await this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
      const current = transaction.getTurn(turnId);
      if (current === undefined || isTerminalTurn(current.state)) return;
      if (current.state === "DISPATCHED") {
        const running = transitionTurn(current, "RUNNING", this.clock.now()).value;
        transaction.putTurn({ ...running, nativeTurnId });
      } else if (current.state === "RUNNING" && current.nativeTurnId === undefined) {
        transaction.putTurn({ ...current, nativeTurnId, updatedAt: this.clock.now() });
      }
    }));
  }

  public async fail(turnId: string, state: "FAILED" | "CANCELLED" | "UNKNOWN"): Promise<void> {
    const sessionId = this.store.transaction((tx) => tx.getTurn(turnId)?.sessionId);
    if (sessionId === undefined) throw new DomainError("turn_not_found", "Turn was not found");
    await this.linearizer.run(sessionId, () => {
      this.store.transaction((transaction) => {
        const turn = transaction.getTurn(turnId);
        if (turn === undefined) throw new DomainError("turn_not_found", "Turn was not found");
        if (isTerminalTurn(turn.state)) return;
        transaction.putTurn(transitionTurn(turn, state, this.clock.now()).value);
        const session = transaction.getSession(sessionId);
        if (session !== undefined) transaction.putSession({ ...session, queuePaused: true });
        for (const queued of transaction.listTurns(sessionId).filter((item) => item.state === "QUEUED")) {
          transaction.putTurn(transitionTurn(queued, "PAUSED", this.clock.now()).value);
        }
      });
    });
  }

  public async completeDeniedApproval(turnId: string): Promise<void> {
    const sessionId = this.store.transaction((tx) => tx.getTurn(turnId)?.sessionId);
    if (sessionId === undefined) throw new DomainError("turn_not_found", "Turn was not found");
    const candidate = await this.linearizer.run(sessionId, () => {
      this.store.transaction((transaction) => {
        const turn = transaction.getTurn(turnId);
        if (turn === undefined) throw new DomainError("turn_not_found", "Turn was not found");
        if (isTerminalTurn(turn.state)) return;
        const now = this.clock.now();
        transaction.putTurn(transitionTurn(turn, "CANCELLED", now).value);
        const session = transaction.getSession(sessionId);
        if (session !== undefined) transaction.putSession({ ...session, lastActivityAt: now });
      });
      return this.takeNextLocked(sessionId);
    });
    await this.dispatch(candidate);
  }

  public completeExplicitCancellation(
    turnId: string
  ): Promise<"cancelled" | "cancelled_paused"> {
    const sessionId = this.store.transaction((tx) => tx.getTurn(turnId)?.sessionId);
    if (sessionId === undefined) throw new DomainError("turn_not_found", "Turn was not found");
    return this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
      const turn = transaction.getTurn(turnId);
      if (turn === undefined) throw new DomainError("turn_not_found", "Turn was not found");
      const now = this.clock.now();
      if (!isTerminalTurn(turn.state)) {
        transaction.putTurn(transitionTurn(turn, "CANCELLED", now).value);
      }
      for (const queued of transaction.listTurns(sessionId).filter(
        (item) => item.state === "QUEUED"
      )) {
        transaction.putTurn(transitionTurn(queued, "PAUSED", now).value);
      }
      const shouldPause = transaction.listTurns(sessionId).some((item) =>
        activeStates.has(item.state) ||
        item.state === "UNKNOWN" ||
        item.state === "QUEUED" ||
        item.state === "PAUSED"
      );
      const session = transaction.getSession(sessionId);
      if (session !== undefined) {
        transaction.putSession({
          ...session,
          queuePaused: shouldPause,
          lastActivityAt: now,
          updatedAt: now
        });
      }
      return shouldPause ? "cancelled_paused" : "cancelled";
    }));
  }

  public async waitForApproval(turnId: string): Promise<void> {
    await this.transitionApprovalState(turnId, "WAITING_AGENT_APPROVAL");
  }

  public async approvalResolved(turnId: string): Promise<void> {
    await this.transitionApprovalState(turnId, "RUNNING");
  }

  public async resumeQueue(sessionId: SessionId): Promise<void> {
    const candidate = await this.linearizer.run(sessionId, () => {
      this.store.transaction((transaction) => {
        const session = transaction.getSession(sessionId);
        if (session?.state !== "OPEN") throw new DomainError("session_not_open", "Session is not open");
        if (transaction.listTurns(sessionId).some((turn) => turn.state === "UNKNOWN")) {
          throw new DomainError(
            "turn_status_unknown",
            "Queue cannot resume until every UNKNOWN Turn is reconciled"
          );
        }
        transaction.putSession({ ...session, queuePaused: false, updatedAt: this.clock.now() });
        for (const paused of transaction.listTurns(sessionId).filter((turn) => turn.state === "PAUSED")) {
          transaction.putTurn(transitionTurn(paused, "QUEUED", this.clock.now()).value);
        }
      });
      return this.takeNextLocked(sessionId);
    });
    await this.dispatch(candidate);
  }

  public prepareRecoveredSession(sessionId: SessionId): Promise<RecoveredQueueDisposition> {
    return this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
      const session = transaction.getSession(sessionId);
      if (session?.state !== "OPEN" || session.runtimeState !== "ALIVE") {
        throw new DomainError("session_not_open", "Session is not open");
      }
      const turns = transaction.listTurns(sessionId);
      if (turns.some((turn) => turn.state === "UNKNOWN")) return { kind: "unknown" };
      const active = turns.find((turn) => activeStates.has(turn.state));
      if (active !== undefined) return { kind: "active", turn: active };
      const paused = turns.filter((turn) => turn.state === "QUEUED" || turn.state === "PAUSED");
      if (paused.length > 0) return { kind: "paused", count: paused.length };
      if (session.queuePaused) {
        transaction.putSession({
          ...session,
          queuePaused: false,
          updatedAt: this.clock.now()
        });
      }
      return { kind: "ready" };
    }));
  }

  public async stop(
    sessionId: SessionId
  ): Promise<"cancelled" | "cancelled_paused" | "already_resolved"> {
    if (!this.agent.capabilities(sessionId).cancellation) {
      throw new DomainError("cancel_unsupported", "Agent does not support cancellation");
    }
    const active = await this.linearizer.run(sessionId, () =>
      this.store.transaction((transaction) =>
        transaction.listTurns(sessionId).find((turn) => activeStates.has(turn.state))
      )
    );
    if (active === undefined) return "already_resolved";
    try {
      await this.agent.cancel(sessionId, active.id);
      return this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
        const current = transaction.getTurn(active.id);
        if (current === undefined || isTerminalTurn(current.state)) return "already_resolved";
        transaction.putTurn(transitionTurn(current, "CANCELLED", this.clock.now()).value);
        const queued = transaction.listTurns(sessionId).filter((turn) => turn.state === "QUEUED");
        for (const item of queued) {
          transaction.putTurn(transitionTurn(item, "PAUSED", this.clock.now()).value);
        }
        const shouldPause = transaction.listTurns(sessionId).some((turn) =>
          activeStates.has(turn.state) ||
          turn.state === "UNKNOWN" ||
          turn.state === "QUEUED" ||
          turn.state === "PAUSED"
        );
        const session = transaction.getSession(sessionId);
        if (session !== undefined) {
          transaction.putSession({
            ...session,
            queuePaused: shouldPause,
            updatedAt: this.clock.now()
          });
        }
        return shouldPause ? "cancelled_paused" : "cancelled";
      }));
    } catch (error) {
      await this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
        const current = transaction.getTurn(active.id);
        if (current !== undefined && !isTerminalTurn(current.state)) {
          transaction.putTurn(transitionTurn(current, "UNKNOWN", this.clock.now()).value);
        }
      }));
      throw error;
    }
  }

  public async close(
    sessionId: SessionId
  ): Promise<"closed" | "empty_session_deleted" | "already_resolved"> {
    const prepared = await this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
      const current = transaction.getSession(sessionId);
      if (current === undefined) throw new DomainError("session_not_found", "Session was not found");
      if (current.state === "CLOSED") return undefined;
      const next = transitionSession(current, "CLOSING", this.clock.now()).value;
      transaction.putSession(next);
      return {
        original: current,
        closing: next,
        // A Session with no submitted Turn has no user-visible history.  It is
        // equivalent to an abandoned creation, so /close removes it instead
        // of leaving an archive that can later be reopened.
        empty: current.nativeLifecycleOwner === "AGENTLINK" &&
          transaction.listTurns(sessionId).length === 0
      };
    }));
    if (prepared === undefined) return "already_resolved";
    try {
      if (prepared.empty) {
        await this.agent.deleteNativeSession(prepared.closing);
        this.agent.forgetNativeSessions?.([prepared.closing]);
        return this.finishEmptyDelete(sessionId);
      }
      const nativeResult = prepared.closing.nativeLifecycleOwner === "AGENTLINK"
        ? await this.agent.close(prepared.closing)
        : await this.agent.detach(prepared.closing);
      if (prepared.closing.nativeLifecycleOwner === "AGENTLINK") {
        // The Codex adapter reports this only after its exact empty thread has
        // been deleted because there was no native rollout to archive.
        return this.finishClose(sessionId, nativeResult === "empty_session_deleted");
      } else {
        return this.finishClose(sessionId, false);
      }
    } catch (error) {
      await this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
        const current = transaction.getSession(sessionId);
        if (current?.state === "CLOSING") {
          transaction.putSession(error instanceof DomainError
            ? {
                ...prepared.original,
                updatedAt: this.clock.now()
              }
            : {
                ...transitionSession(current, "UNKNOWN", this.clock.now()).value,
                runtimeState: "UNKNOWN"
              });
        }
      }));
      throw error;
    }
  }

  private async finishEmptyDelete(
    sessionId: SessionId
  ): Promise<"empty_session_deleted" | "already_resolved"> {
    return this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
      const current = transaction.getSession(sessionId);
      if (current?.state !== "CLOSING") return "already_resolved";
      transaction.deleteSession(sessionId);
      return "empty_session_deleted";
    }));
  }

  private async finishClose(
    sessionId: SessionId,
    emptySessionDeleted: boolean
  ): Promise<"closed" | "empty_session_deleted" | "already_resolved"> {
    return this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
        const current = transaction.getSession(sessionId);
        if (current?.state !== "CLOSING") return "already_resolved";
        transaction.putSession({
          ...transitionSession(current, "CLOSED", this.clock.now()).value,
          runtimeState: "UNKNOWN",
          queuePaused: true
        });
        for (const turn of transaction.listTurns(sessionId)) {
          if (turn.state === "QUEUED" || turn.state === "PAUSED") {
            transaction.putTurn(transitionTurn(turn, "CANCELLED", this.clock.now()).value);
          }
        }
        return emptySessionDeleted ? "empty_session_deleted" : "closed";
      }));
  }

  public async steer(sessionId: SessionId, sourceEndpointId: string, text: string): Promise<void> {
    if (!this.agent.capabilities(sessionId).steering) {
      throw new DomainError(
        "steer_unsupported",
        "当前Agent不支持向执行中的任务追加指令；请等待完成后发送新消息"
      );
    }
    const active = await this.linearizer.run(sessionId, () => this.store.transaction((tx) =>
      tx.listTurns(sessionId).find((turn) => turn.state === "RUNNING")
    ));
    if (active === undefined) throw new DomainError("no_running_turn", "No running Turn");
    await this.agent.steer({
      sessionId,
      turnId: active.id,
      text: `[${sourceEndpointId}] ${text}`
    });
    this.store.transaction((transaction) => {
      const session = transaction.getSession(sessionId);
      if (session !== undefined) {
        transaction.putSession({ ...session, lastActivityAt: this.clock.now() });
      }
    });
  }

  public cancelQueued(sessionId: SessionId, turnId: string): Promise<"cancelled" | "already_resolved"> {
    return this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
      const turn = transaction.getTurn(turnId);
      if (turn === undefined || turn.sessionId !== sessionId) {
        throw new DomainError("turn_not_found", "Turn was not found");
      }
      if (isTerminalTurn(turn.state)) return "already_resolved";
      if (turn.state !== "QUEUED" && turn.state !== "PAUSED") {
        throw new DomainError("turn_active", "Use stop for an active Turn");
      }
      transaction.putTurn(transitionTurn(turn, "CANCELLED", this.clock.now()).value);
      this.clearEmptyPauseLocked(transaction, sessionId);
      return "cancelled";
    }));
  }

  public cancelOnlyQueued(sessionId: SessionId): Promise<Turn | undefined> {
    return this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
      const cancellable = transaction.listTurns(sessionId)
        .filter((turn) => turn.state === "QUEUED" || turn.state === "PAUSED")
        .sort((left, right) => (left.queueSequence ?? 0) - (right.queueSequence ?? 0));
      if (cancellable.length === 0) return undefined;
      if (cancellable.length > 1) {
        throw new DomainError(
          "queue_cancel_ambiguous",
          "存在多个可取消任务，请使用 /queue 查看后指定编号"
        );
      }
      const turn = cancellable[0]!;
      transaction.putTurn(transitionTurn(turn, "CANCELLED", this.clock.now()).value);
      this.clearEmptyPauseLocked(transaction, sessionId);
      return turn;
    }));
  }

  private clearEmptyPauseLocked(transaction: Transaction, sessionId: SessionId): void {
    const remaining = transaction.listTurns(sessionId);
    if (remaining.some((turn) =>
      activeStates.has(turn.state) ||
      turn.state === "UNKNOWN" ||
      turn.state === "QUEUED" ||
      turn.state === "PAUSED"
    )) return;
    const session = transaction.getSession(sessionId);
    if (session?.queuePaused) {
      transaction.putSession({
        ...session,
        queuePaused: false,
        updatedAt: this.clock.now()
      });
    }
  }

  private takeNextLocked(sessionId: SessionId): Turn | undefined {
    return this.store.transaction((transaction) => {
      const turns = transaction.listTurns(sessionId);
      if (turns.some((turn) => activeStates.has(turn.state) || turn.state === "UNKNOWN")) return undefined;
      const next = turns
        .filter((turn) => turn.state === "QUEUED")
        .sort((left, right) => (left.queueSequence ?? 0) - (right.queueSequence ?? 0))[0];
      if (next === undefined) return undefined;
      try {
        this.admissionGate?.assertCanStartTurn(next.sessionId, next.sourceEndpointId);
      } catch (error) {
        if (error instanceof DomainError && error.code === "update_in_progress") return undefined;
        throw error;
      }
      const dispatched = transitionTurn(next, "DISPATCHED", this.clock.now()).value;
      transaction.putTurn(dispatched);
      return dispatched;
    });
  }

  private async dispatch(candidate: Turn | undefined): Promise<void> {
    if (candidate === undefined) return;
    try {
      const result = await this.agent.sendTurn({
        sessionId: candidate.sessionId,
        turnId: candidate.id,
        text: candidate.text
      });
      await this.linearizer.run(candidate.sessionId, () => this.store.transaction((transaction) => {
        const current = transaction.getTurn(candidate.id);
        if (current?.state !== "DISPATCHED") return;
        const running = transitionTurn(current, "RUNNING", this.clock.now()).value;
        transaction.putTurn({ ...running, nativeTurnId: result.nativeTurnId });
      }));
    } catch {
      await this.linearizer.run(candidate.sessionId, () => this.store.transaction((transaction) => {
        const current = transaction.getTurn(candidate.id);
        if (current?.state === "DISPATCHED") {
          transaction.putTurn(transitionTurn(current, "UNKNOWN", this.clock.now()).value);
        }
        const session = transaction.getSession(candidate.sessionId);
        if (session !== undefined) transaction.putSession({ ...session, queuePaused: true });
        for (const queued of transaction.listTurns(candidate.sessionId).filter(
          (turn) => turn.state === "QUEUED"
        )) {
          transaction.putTurn(transitionTurn(queued, "PAUSED", this.clock.now()).value);
        }
      }));
    }
  }

  private async transitionApprovalState(
    turnId: string,
    state: "WAITING_AGENT_APPROVAL" | "RUNNING"
  ): Promise<void> {
    const sessionId = this.store.transaction((transaction) =>
      transaction.getTurn(turnId)?.sessionId
    );
    if (sessionId === undefined) throw new DomainError("turn_not_found", "Turn was not found");
    await this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
      const turn = transaction.getTurn(turnId);
      if (turn === undefined) throw new DomainError("turn_not_found", "Turn was not found");
      if (isTerminalTurn(turn.state)) return;
      if (turn.state === state) return;
      transaction.putTurn(transitionTurn(turn, state, this.clock.now()).value);
    }));
  }
}
