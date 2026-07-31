import type {
  ApprovalLeaseEffects,
  Clock,
  ControllerInputGate,
  StateStore
} from "../contracts/ports.js";
import { DomainError } from "../domain/errors.js";
import { transitionTurn } from "../domain/transitions.js";

export class MobileAttachmentService implements ApprovalLeaseEffects, ControllerInputGate {
  readonly #attached = new Set<string>();
  readonly #managed = new Set<string>();

  public constructor(
    private readonly store: StateStore,
    private readonly clock: Clock
  ) {}

  public expireMobileWrite(
    sessionId: string,
    controllerEndpointId: string
  ): void {
    this.store.transaction((transaction) => {
      const session = transaction.getSession(sessionId);
      if (session === undefined) throw new DomainError("session_not_found", "Session was not found");
      transaction.putSession({
        ...session,
        queuePaused: true,
        updatedAt: this.clock.now()
      });
      for (const turn of transaction.listTurns(sessionId)) {
        if (turn.state === "QUEUED") {
          transaction.putTurn(transitionTurn(turn, "PAUSED", this.clock.now()).value);
        }
      }
    });
    this.#attached.delete(attachmentKey(sessionId, controllerEndpointId));
  }

  public restoreMobileWrite(
    sessionId: string,
    controllerEndpointId: string
  ): void {
    const session = this.store.transaction((transaction) => transaction.getSession(sessionId));
    if (session?.state !== "OPEN" || session.runtimeState !== "ALIVE") {
      throw new DomainError("attachment_runtime_untrusted", "Session Runtime is not trusted");
    }
    this.#attached.add(attachmentKey(sessionId, controllerEndpointId));
    this.#managed.add(attachmentKey(sessionId, controllerEndpointId));
  }

  public attachInitial(sessionId: string, controllerEndpointId: string): void {
    const key = attachmentKey(sessionId, controllerEndpointId);
    this.#managed.add(key);
    this.#attached.add(key);
  }

  public assertCanSubmit(sessionId: string, controllerEndpointId: string): void {
    const key = attachmentKey(sessionId, controllerEndpointId);
    if (this.#managed.has(key) && !this.#attached.has(key)) {
      throw new DomainError(
        "attachment_not_writable",
        "Controller must attach before submitting ordinary input"
      );
    }
  }

  public assertWritable(sessionId: string, controllerEndpointId: string): void {
    this.assertCanSubmit(sessionId, controllerEndpointId);
  }

  public isAttached(sessionId: string, controllerEndpointId: string): boolean {
    return this.#attached.has(attachmentKey(sessionId, controllerEndpointId));
  }

  public forgetSession(sessionId: string): void {
    const prefix = `${sessionId.length}:${sessionId}|`;
    for (const key of this.#managed) {
      if (!key.startsWith(prefix)) continue;
      this.#managed.delete(key);
      this.#attached.delete(key);
    }
  }
}

function attachmentKey(sessionId: string, controllerEndpointId: string): string {
  return `${sessionId.length}:${sessionId}|${controllerEndpointId.length}:${controllerEndpointId}`;
}
