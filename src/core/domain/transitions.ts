import { InvalidTransitionError } from "./errors.js";
import type {
  AgentSession,
  AgentRuntime,
  DomainEvent,
  SessionState,
  RuntimeState,
  Transition,
  Turn,
  TurnState
} from "./model.js";

const sessionEdges: Readonly<Record<SessionState, readonly SessionState[]>> = {
  CREATING: ["OPEN", "UNKNOWN"],
  OPEN: ["CLOSING", "UNKNOWN"],
  CLOSING: ["CLOSED", "UNKNOWN"],
  CLOSED: ["CREATING"],
  UNKNOWN: ["CREATING", "OPEN", "CLOSING", "CLOSED"]
};

const runtimeEdges: Readonly<Record<RuntimeState, readonly RuntimeState[]>> = {
  STARTING: ["ALIVE", "EXITED", "UNKNOWN"],
  ALIVE: ["EXITED", "UNKNOWN"],
  EXITED: ["STARTING"],
  UNKNOWN: ["ALIVE", "EXITED"]
};

const turnEdges: Readonly<Record<TurnState, readonly TurnState[]>> = {
  RECEIVED: ["QUEUED", "PAUSED"],
  QUEUED: ["DISPATCHED", "CANCELLED", "PAUSED"],
  PAUSED: ["QUEUED", "CANCELLED"],
  DISPATCHED: ["RUNNING", "FAILED", "CANCELLED", "UNKNOWN"],
  RUNNING: ["WAITING_AGENT_APPROVAL", "COMPLETED", "FAILED", "CANCELLED", "UNKNOWN"],
  WAITING_AGENT_APPROVAL: ["RUNNING", "COMPLETED", "FAILED", "CANCELLED", "UNKNOWN"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  UNKNOWN: ["RUNNING", "COMPLETED", "FAILED", "CANCELLED"]
};

function event(type: string, aggregateId: string, from: string, to: string, at: string): DomainEvent {
  return { type, aggregateId, occurredAt: at, data: { from, to } };
}

export function transitionSession(
  session: AgentSession,
  to: SessionState,
  at: string
): Transition<AgentSession> {
  if (!sessionEdges[session.state].includes(to)) {
    throw new InvalidTransitionError("Session", session.state, to);
  }
  return {
    value: { ...session, state: to, updatedAt: at },
    event: event("session.state_changed", session.id, session.state, to, at)
  };
}

export function transitionTurn(turn: Turn, to: TurnState, at: string): Transition<Turn> {
  if (!turnEdges[turn.state].includes(to)) {
    throw new InvalidTransitionError("Turn", turn.state, to);
  }
  return {
    value: { ...turn, state: to, updatedAt: at },
    event: event("turn.state_changed", turn.id, turn.state, to, at)
  };
}

export function transitionRuntime(
  runtime: AgentRuntime,
  to: RuntimeState,
  at: string
): Transition<AgentRuntime> {
  if (!runtimeEdges[runtime.state].includes(to)) {
    throw new InvalidTransitionError("Runtime", runtime.state, to);
  }
  return {
    value: { ...runtime, state: to, updatedAt: at },
    event: event("runtime.state_changed", runtime.id, runtime.state, to, at)
  };
}

export function isTerminalTurn(state: TurnState): boolean {
  return state === "COMPLETED" || state === "FAILED" || state === "CANCELLED";
}

export const allowedSessionTransitions = sessionEdges;
export const allowedRuntimeTransitions = runtimeEdges;
export const allowedTurnTransitions = turnEdges;
