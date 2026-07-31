import type { Clock, RuntimeSnapshot, StateStore } from "../contracts/ports.js";
import { transitionSession, transitionTurn } from "../domain/transitions.js";
import { SessionLinearizer } from "./session-linearizer.js";

export class RuntimeFailureService {
  public constructor(
    private readonly store: StateStore,
    private readonly clock: Clock,
    private readonly linearizer: SessionLinearizer
  ) {}

  public async handleExit(snapshot: RuntimeSnapshot): Promise<void> {
    await Promise.all(snapshot.affectedSessionIds.map((sessionId) =>
      this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
        const session = transaction.getSession(sessionId);
        if (session !== undefined && session.state !== "CLOSED" && session.state !== "UNKNOWN") {
          transaction.putSession({
            ...transitionSession(session, "UNKNOWN", this.clock.now()).value,
            runtimeState: "EXITED",
            queuePaused: true
          });
        }
        for (const turn of transaction.listTurns(sessionId)) {
          if (
            turn.state === "DISPATCHED" ||
            turn.state === "RUNNING" ||
            turn.state === "WAITING_AGENT_APPROVAL"
          ) {
            transaction.putTurn(transitionTurn(turn, "UNKNOWN", this.clock.now()).value);
          } else if (turn.state === "QUEUED") {
            transaction.putTurn(transitionTurn(turn, "PAUSED", this.clock.now()).value);
          }
        }
      }))
    ));
  }
}
