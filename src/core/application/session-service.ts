import type {
  AgentPort,
  Clock,
  ExternalAgentSessionCandidate,
  IdGenerator,
  StateStore
} from "../contracts/ports.js";
import {
  AgentAuthenticationRequiredError,
  AgentOperationUncertainError,
  DomainError
} from "../domain/errors.js";
import type { AgentSession } from "../domain/model.js";
import { isTerminalTurn, transitionSession, transitionTurn } from "../domain/transitions.js";
import { sanitizeDisplayName } from "./mobile-text.js";
import { SessionLinearizer } from "./session-linearizer.js";

export class SessionService {
  public constructor(
    private readonly store: StateStore,
    private readonly agent: AgentPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly linearizer: SessionLinearizer
  ) {}

  public async create(
    projectId: string,
    agentKind: string,
    displayName = projectId
  ): Promise<AgentSession> {
    const now = this.clock.now();
    const session: AgentSession = {
      id: this.ids.next("session"),
      projectId,
      agentKind,
      displayName,
      lastActivityAt: now,
      nativeLifecycleOwner: "AGENTLINK",
      state: "CREATING",
      runtimeState: "STARTING",
      queuePaused: false,
      createdAt: now,
      updatedAt: now
    };
    this.store.transaction((transaction) => transaction.putSession(session));
    try {
      const native = await this.agent.create(session);
      return this.linearizer.run(session.id, () => this.store.transaction((transaction) => {
        const current = transaction.getSession(session.id);
        if (current?.state !== "CREATING") {
          throw new DomainError("session_create_race", "Session changed while Agent was creating it");
        }
        const opened = transitionSession(current, "OPEN", this.clock.now()).value;
        const resolved: AgentSession = {
          ...opened,
          nativeSessionId: native.nativeSessionId,
          runtimeId: native.runtimeId,
          runtimeState: "ALIVE"
        };
        transaction.putSession(resolved);
        return resolved;
      }));
    } catch (error) {
      if (error instanceof AgentAuthenticationRequiredError) {
        await this.linearizer.run(session.id, () => this.store.transaction((transaction) => {
          const current = transaction.getSession(session.id);
          if (current?.state === "CREATING") transaction.deleteSession(session.id);
        }));
      } else {
        await this.markUnknown(session.id);
      }
      throw error;
    }
  }

  public discoverExternal(
    projectId: string,
    agentKind?: string
  ): Promise<readonly ExternalAgentSessionCandidate[]> {
    if (this.agent.discoverExternalSessions === undefined) {
      throw new DomainError(
        "external_session_discovery_unsupported",
        "当前Agent不支持发现既有Session"
      );
    }
    return this.agent.discoverExternalSessions(projectId, agentKind);
  }

  public async importExternal(
    projectId: string,
    agentKind: string,
    candidate: ExternalAgentSessionCandidate
  ): Promise<AgentSession> {
    if (this.agent.importExternalSession === undefined) {
      throw new DomainError(
        "external_session_import_unsupported",
        "当前Agent不支持导入既有Session"
      );
    }
    const now = this.clock.now();
    const session: AgentSession = {
      id: this.ids.next("session"),
      projectId,
      agentKind,
      nativeSessionId: candidate.nativeSessionId,
      sourceNativeSessionId: candidate.nativeSessionId,
      historyTruncated: false,
      displayName: sanitizeDisplayName(candidate.displayName, projectId),
      lastActivityAt: candidate.lastActivityAt,
      nativeLifecycleOwner: "EXTERNAL",
      state: "CREATING",
      runtimeState: "STARTING",
      queuePaused: false,
      createdAt: now,
      updatedAt: now
    };
    this.store.transaction((transaction) => transaction.putSession(session));
    let nativeImported = false;
    try {
      const imported = await this.agent.importExternalSession(session, candidate);
      nativeImported = true;
      if (imported.sourceNativeSessionId !== candidate.nativeSessionId) {
        throw new DomainError(
          "external_session_identity_mismatch",
          "Codex返回了不同的Session标识"
        );
      }
      return this.linearizer.run(session.id, () => this.store.transaction((transaction) => {
        const current = transaction.getSession(session.id);
        if (current?.state !== "CREATING") {
          throw new DomainError(
            "external_session_import_race",
            "Session在导入期间发生变化"
          );
        }
        const opened = transitionSession(current, "OPEN", this.clock.now()).value;
        const resolved: AgentSession = {
          ...opened,
          nativeSessionId: imported.nativeSessionId,
          sourceNativeSessionId: imported.sourceNativeSessionId,
          nativeLifecycleOwner: imported.nativeLifecycleOwner,
          historyTruncated: imported.historyTruncated,
          runtimeId: imported.runtimeId,
          runtimeState: "ALIVE",
          displayName: sanitizeDisplayName(imported.displayName, current.displayName),
          lastActivityAt: imported.lastActivityAt
        };
        transaction.putSession(resolved);
        return resolved;
      }));
    } catch (error) {
      if (
        nativeImported &&
        this.agent.rollbackExternalSessionImport !== undefined
      ) {
        try {
          await this.agent.rollbackExternalSessionImport(session, candidate);
        } catch (rollbackError) {
          await this.markUnknown(session.id);
          throw new AgentOperationUncertainError(
            "External Session import could not be rolled back",
            { cause: rollbackError }
          );
        }
      }
      await this.linearizer.run(session.id, () => this.store.transaction((transaction) => {
        const current = transaction.getSession(session.id);
        if (current?.state === "CREATING") transaction.deleteSession(session.id);
      }));
      throw error;
    }
  }

  public async resume(sessionId: string): Promise<AgentSession> {
    const prepared = await this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
      const current = transaction.getSession(sessionId);
      if (current === undefined) throw new DomainError("session_not_found", "Session was not found");
      if (current.nativeSessionId === undefined) {
        throw new DomainError("native_session_missing", "Session has no native resume identifier");
      }
      const next = transitionSession(current, "CREATING", this.clock.now()).value;
      const starting = { ...next, runtimeState: "STARTING" as const };
      transaction.putSession(starting);
      return {
        original: current,
        session: starting,
        turns: transaction.listTurns(sessionId)
      };
    }));
    try {
      const native = await this.agent.resume(prepared.session, prepared.turns, {
        reopenClosed: prepared.original.state === "CLOSED" &&
          prepared.original.nativeLifecycleOwner === "AGENTLINK"
      });
      return this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
        const current = transaction.getSession(sessionId);
        if (current?.state !== "CREATING") {
          throw new DomainError("session_resume_race", "Session changed while Agent was resuming it");
        }
        for (const reconciliation of native.reconciledTurns) {
          const turn = transaction.getTurn(reconciliation.turnId);
          if (turn === undefined || turn.sessionId !== sessionId) {
            throw new DomainError(
              "turn_reconciliation_mismatch",
              "Agent reconciled a Turn outside the resumed Session"
            );
          }
          if (turn.state === "UNKNOWN" && reconciliation.state !== "UNKNOWN") {
            transaction.putTurn(
              transitionTurn(turn, reconciliation.state, this.clock.now()).value
            );
          }
        }
        if (transaction.listTurns(sessionId).some((turn) => turn.state === "UNKNOWN")) {
          const unresolved = transitionSession(current, "UNKNOWN", this.clock.now()).value;
          const result: AgentSession = {
            ...unresolved,
            runtimeId: native.runtimeId,
            runtimeState: "ALIVE",
            displayName: native.displayName === undefined
              ? unresolved.displayName
              : sanitizeDisplayName(native.displayName, unresolved.displayName)
          };
          transaction.putSession(result);
          return result;
        }
        const opened = transitionSession(current, "OPEN", this.clock.now()).value;
        const resolved: AgentSession = {
          ...opened,
          runtimeId: native.runtimeId,
          runtimeState: "ALIVE",
          displayName: native.displayName === undefined
            ? opened.displayName
            : sanitizeDisplayName(native.displayName, opened.displayName)
        };
        transaction.putSession(resolved);
        return resolved;
      }));
    } catch (error) {
      if (error instanceof AgentOperationUncertainError) {
        await this.markUnknown(sessionId);
      } else {
        await this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
          const current = transaction.getSession(sessionId);
          if (current?.state === "CREATING") {
            transaction.putSession({
              ...prepared.original,
              updatedAt: this.clock.now()
            });
          }
        }));
      }
      throw error;
    }
  }

  public async deleteOwned(
    sessionId: string,
    deleteNativeSession: (session: AgentSession) => Promise<void> =
      (session) => this.agent.deleteNativeSession(session)
  ): Promise<void> {
    const session = await this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
      const current = transaction.getSession(sessionId);
      if (current === undefined) throw new DomainError("session_not_found", "Session was not found");
      if (current.nativeLifecycleOwner !== "AGENTLINK") {
        throw new DomainError(
          "native_session_not_owned",
          "AgentLink只能删除自己创建的Codex Session"
        );
      }
      if (transaction.listTurns(sessionId).some((turn) => !isTerminalTurn(turn.state))) {
        throw new DomainError("session_busy", "Session仍有未完成Turn，不能删除");
      }
      if (current.nativeSessionId === undefined) {
        throw new DomainError("native_session_missing", "Session缺少native thread ID");
      }
      if (current.state === "CLOSING") {
        throw new DomainError("session_busy", "Session正在关闭或删除");
      }
      if (current.state === "OPEN" || current.state === "UNKNOWN") {
        transaction.putSession({
          ...transitionSession(current, "CLOSING", this.clock.now()).value,
          queuePaused: true
        });
      }
      return current;
    }));
    try {
      await deleteNativeSession(session);
      this.agent.forgetNativeSessions?.([session]);
      await this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
        const current = transaction.getSession(sessionId);
        if (current !== undefined) transaction.deleteSession(sessionId);
      }));
    } catch (error) {
      if (error instanceof DomainError) throw error;
      await this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
        const current = transaction.getSession(sessionId);
        if (current !== undefined) {
          transaction.putSession({
            ...current,
            state: "UNKNOWN",
            runtimeState: "UNKNOWN",
            queuePaused: true,
            updatedAt: this.clock.now()
          });
        }
      }));
      throw new AgentOperationUncertainError("Native Session deletion is uncertain", {
        cause: error
      });
    }
  }

  public async detachExternal(sessionId: string): Promise<AgentSession> {
    const session = await this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
      const current = transaction.getSession(sessionId);
      if (current === undefined) throw new DomainError("session_not_found", "Session was not found");
      if (current.nativeLifecycleOwner !== "EXTERNAL") {
        throw new DomainError("native_session_owned", "AgentLink创建的Session不能detach");
      }
      if (transaction.listTurns(sessionId).some((turn) => !isTerminalTurn(turn.state))) {
        throw new DomainError("session_busy", "Session仍有未完成Turn，不能detach");
      }
      if (current.state === "CLOSING") {
        throw new DomainError("session_busy", "Session正在关闭或detach");
      }
      if (current.state === "OPEN" || current.state === "UNKNOWN") {
        transaction.putSession({
          ...transitionSession(current, "CLOSING", this.clock.now()).value,
          queuePaused: true
        });
      }
      return current;
    }));
    try {
      await this.agent.detach(session);
      return this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
        const current = transaction.getSession(sessionId);
        if (current === undefined) throw new DomainError("session_not_found", "Session was not found");
        const {
          nativeSessionId: _nativeSessionId,
          sourceNativeSessionId: _sourceNativeSessionId,
          historyTruncated: _historyTruncated,
          runtimeId: _runtimeId,
          ...retained
        } = current;
        const detached: AgentSession = {
          ...retained,
          historyTruncated: false,
          state: "CLOSED",
          runtimeState: "UNKNOWN",
          queuePaused: true,
          updatedAt: this.clock.now()
        };
        transaction.putSession(detached);
        return detached;
      }));
    } catch (error) {
      if (error instanceof DomainError) throw error;
      await this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
        const current = transaction.getSession(sessionId);
        if (current?.state === "CLOSING") {
          transaction.putSession({
            ...transitionSession(current, "UNKNOWN", this.clock.now()).value,
            runtimeState: "UNKNOWN",
            queuePaused: true
          });
        }
      }));
      throw new AgentOperationUncertainError("Native Session detach is uncertain", { cause: error });
    }
  }

  private markUnknown(sessionId: string): Promise<void> {
    return this.linearizer.run(sessionId, () => this.store.transaction((transaction) => {
      const current = transaction.getSession(sessionId);
      if (current?.state === "CREATING") {
        transaction.putSession({
          ...transitionSession(current, "UNKNOWN", this.clock.now()).value,
          runtimeState: "UNKNOWN"
        });
      }
    }));
  }
}
