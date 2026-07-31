import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidTransitionError } from "../../src/core/domain/errors.js";
import type { AgentRuntime, AgentSession, Turn } from "../../src/core/domain/model.js";
import {
  allowedRuntimeTransitions,
  allowedSessionTransitions,
  allowedTurnTransitions,
  transitionSession,
  transitionRuntime,
  transitionTurn
} from "../../src/core/domain/transitions.js";

const at = "2026-07-18T00:00:01.000Z";

test("all declared Session edges are accepted and all other edges are rejected", () => {
  for (const from of Object.keys(allowedSessionTransitions) as (keyof typeof allowedSessionTransitions)[]) {
    const session: AgentSession = {
      id: "session-1", projectId: "project-1", agentKind: "fake",
      displayName: "project", lastActivityAt: at,
      nativeLifecycleOwner: "AGENTLINK",
      state: from, runtimeState: "ALIVE", queuePaused: false, createdAt: at, updatedAt: at
    };
    for (const to of Object.keys(allowedSessionTransitions) as (keyof typeof allowedSessionTransitions)[]) {
      if (allowedSessionTransitions[from].includes(to)) {
        assert.equal(transitionSession(session, to, at).value.state, to);
      } else {
        assert.throws(() => transitionSession(session, to, at), InvalidTransitionError);
      }
    }
  }
});

test("all declared Turn edges are accepted and all other edges are rejected", () => {
  for (const from of Object.keys(allowedTurnTransitions) as (keyof typeof allowedTurnTransitions)[]) {
    const turn: Turn = {
      id: "turn-1", sessionId: "session-1", state: from, inputSequence: 1,
      sourceEndpointId: "endpoint-1", text: "hello", createdAt: at, updatedAt: at
    };
    for (const to of Object.keys(allowedTurnTransitions) as (keyof typeof allowedTurnTransitions)[]) {
      if (allowedTurnTransitions[from].includes(to)) {
        assert.equal(transitionTurn(turn, to, at).value.state, to);
      } else {
        assert.throws(() => transitionTurn(turn, to, at), InvalidTransitionError);
      }
    }
  }
});

test("all declared Runtime edges are accepted and all other edges are rejected", () => {
  for (const from of Object.keys(allowedRuntimeTransitions) as (keyof typeof allowedRuntimeTransitions)[]) {
    const runtime: AgentRuntime = {
      id: "runtime-1", state: from, affectedSessionIds: ["session-1"], updatedAt: at
    };
    for (const to of Object.keys(allowedRuntimeTransitions) as (keyof typeof allowedRuntimeTransitions)[]) {
      if (allowedRuntimeTransitions[from].includes(to)) {
        assert.equal(transitionRuntime(runtime, to, at).value.state, to);
      } else {
        assert.throws(() => transitionRuntime(runtime, to, at), InvalidTransitionError);
      }
    }
  }
});
