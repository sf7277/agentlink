import Database from "better-sqlite3";
import type {
  StateStore,
  Transaction
} from "../core/contracts/ports.js";
import type {
  AgentSession,
  RuntimeState,
  SessionState,
  Turn,
  TurnState
} from "../core/domain/model.js";
import { runMigrations } from "./migrations.js";

interface SessionRow {
  id: string;
  project_id: string;
  agent_kind: string;
  native_session_id: string | null;
  source_native_session_id: string | null;
  history_truncated: 0 | 1;
  native_lifecycle_owner: AgentSession["nativeLifecycleOwner"];
  runtime_id: string | null;
  state: SessionState;
  runtime_state: RuntimeState;
  queue_paused: 0 | 1;
  display_name: string;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
}

interface TurnRow {
  id: string;
  session_id: string;
  state: TurnState;
  input_sequence: number;
  queue_sequence: number | null;
  source_endpoint_id: string;
  text: string;
  native_turn_id: string | null;
  final_response: string | null;
  created_at: string;
  updated_at: string;
}

function sessionFromRow(row: SessionRow): AgentSession {
  return {
    id: row.id,
    projectId: row.project_id,
    agentKind: row.agent_kind,
    displayName: row.display_name,
    lastActivityAt: row.last_activity_at,
    nativeLifecycleOwner: row.native_lifecycle_owner,
    state: row.state,
    runtimeState: row.runtime_state,
    queuePaused: row.queue_paused === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.native_session_id === null ? {} : { nativeSessionId: row.native_session_id }),
    ...(row.source_native_session_id === null
      ? {}
      : { sourceNativeSessionId: row.source_native_session_id }),
    historyTruncated: row.history_truncated === 1,
    ...(row.runtime_id === null ? {} : { runtimeId: row.runtime_id })
  };
}

function turnFromRow(row: TurnRow): Turn {
  return {
    id: row.id,
    sessionId: row.session_id,
    state: row.state,
    inputSequence: row.input_sequence,
    sourceEndpointId: row.source_endpoint_id,
    text: row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.queue_sequence === null ? {} : { queueSequence: row.queue_sequence }),
    ...(row.native_turn_id === null ? {} : { nativeTurnId: row.native_turn_id }),
    ...(row.final_response === null ? {} : { finalResponse: row.final_response })
  };
}

class SqliteTransaction implements Transaction {
  public constructor(private readonly database: Database.Database) {}

  public getSession(id: string): AgentSession | undefined {
    const row = this.database.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id) as
      | SessionRow
      | undefined;
    return row === undefined ? undefined : sessionFromRow(row);
  }

  public putSession(session: AgentSession): void {
    this.database.prepare(`
      INSERT INTO agent_sessions(
        id, project_id, agent_kind, native_session_id, source_native_session_id,
        history_truncated, native_lifecycle_owner,
        runtime_id, state, runtime_state,
        queue_paused, display_name, last_activity_at, created_at, updated_at
      ) VALUES (
        @id, @projectId, @agentKind, @nativeSessionId, @sourceNativeSessionId,
        @historyTruncated, @nativeLifecycleOwner,
        @runtimeId, @state, @runtimeState,
        @queuePaused, @displayName, @lastActivityAt, @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        native_session_id = excluded.native_session_id,
        source_native_session_id = excluded.source_native_session_id,
        history_truncated = excluded.history_truncated,
        native_lifecycle_owner = excluded.native_lifecycle_owner,
        runtime_id = excluded.runtime_id,
        state = excluded.state,
        runtime_state = excluded.runtime_state,
        queue_paused = excluded.queue_paused,
        display_name = excluded.display_name,
        last_activity_at = excluded.last_activity_at,
        updated_at = excluded.updated_at
    `).run({
      ...session,
      nativeSessionId: session.nativeSessionId ?? null,
      sourceNativeSessionId: session.sourceNativeSessionId ?? null,
      historyTruncated: session.historyTruncated === true ? 1 : 0,
      runtimeId: session.runtimeId ?? null,
      queuePaused: session.queuePaused ? 1 : 0
    });
  }

  public deleteSession(id: string): void {
    this.database.prepare("DELETE FROM approval_audit WHERE session_id = ?").run(id);
    this.database.prepare(`
      UPDATE conversation_bindings SET session_id = NULL WHERE session_id = ?
    `).run(id);
    this.database.prepare("DELETE FROM agent_sessions WHERE id = ?").run(id);
  }

  public getTurn(id: string): Turn | undefined {
    const row = this.database.prepare("SELECT * FROM turns WHERE id = ?").get(id) as
      | TurnRow
      | undefined;
    return row === undefined ? undefined : turnFromRow(row);
  }

  public putTurn(turn: Turn): void {
    this.database.prepare(`
      INSERT INTO turns(
        id, session_id, state, input_sequence, queue_sequence, source_endpoint_id, text,
        native_turn_id, final_response, created_at, updated_at
      ) VALUES (
        @id, @sessionId, @state, @inputSequence, @queueSequence, @sourceEndpointId, @text,
        @nativeTurnId, @finalResponse, @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        queue_sequence = excluded.queue_sequence,
        native_turn_id = excluded.native_turn_id,
        final_response = excluded.final_response,
        updated_at = excluded.updated_at
    `).run({
      ...turn,
      queueSequence: turn.queueSequence ?? null,
      nativeTurnId: turn.nativeTurnId ?? null,
      finalResponse: turn.finalResponse ?? null
    });
    this.database.prepare(`
      INSERT OR IGNORE INTO turn_inputs(
        id, turn_id, input_sequence, source_endpoint_id, kind, text, created_at
      ) VALUES (?, ?, 1, ?, 'initial', ?, ?)
    `).run(`${turn.id}:initial`, turn.id, turn.sourceEndpointId, turn.text, turn.createdAt);
  }

  public listTurns(sessionId: string): readonly Turn[] {
    return (this.database.prepare(`
      SELECT * FROM turns WHERE session_id = ? ORDER BY input_sequence
    `).all(sessionId) as TurnRow[]).map(turnFromRow);
  }

  public nextInputSequence(sessionId: string): number {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(input_sequence), 0) + 1 AS next FROM turns WHERE session_id = ?
    `).get(sessionId) as { next: number };
    return row.next;
  }

  public nextQueueSequence(sessionId: string): number {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(queue_sequence), 0) + 1 AS next FROM turns WHERE session_id = ?
    `).get(sessionId) as { next: number };
    return row.next;
  }
}

export class SqliteStateStore implements StateStore {
  public readonly database: Database.Database;
  readonly #transaction: SqliteTransaction;

  public constructor(filename: string, migrationsDirectory: string) {
    this.database = new Database(filename);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    runMigrations(this.database, migrationsDirectory);
    this.#transaction = new SqliteTransaction(this.database);
  }

  public transaction<T>(operation: (transaction: Transaction) => T): T {
    return this.database.transaction(() => operation(this.#transaction))();
  }

  public reconcileStartup(now: string): void {
    this.database.prepare(`
      UPDATE agent_sessions
      SET
        state = CASE WHEN state IN ('CREATING', 'OPEN', 'CLOSING') THEN 'UNKNOWN' ELSE state END,
        runtime_state = CASE WHEN runtime_state IN ('STARTING', 'ALIVE') THEN 'UNKNOWN' ELSE runtime_state END,
        queue_paused = 1,
        updated_at = ?
    `).run(now);
    this.database.prepare(`
      UPDATE turns
      SET
        state = CASE
          WHEN state IN ('DISPATCHED', 'RUNNING', 'WAITING_AGENT_APPROVAL') THEN 'UNKNOWN'
          WHEN state = 'QUEUED' THEN 'PAUSED'
          ELSE state
        END,
        updated_at = ?
    `).run(now);
  }

  public acceptMessageAndTurn(
    accountId: string,
    messageId: string,
    receivedAt: string,
    turn: Turn
  ): boolean {
    return this.database.transaction(() => {
      const result = this.database.prepare(`
        INSERT INTO message_receipts(channel_account_id, platform_message_id, received_at, turn_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(channel_account_id, platform_message_id) DO NOTHING
      `).run(accountId, messageId, receivedAt, turn.id);
      if (result.changes === 0) return false;
      this.#transaction.putTurn(turn);
      return true;
    })();
  }

  public acceptBatchAndCursor(
    accountId: string,
    cursor: string,
    acceptedAt: string,
    messages: readonly { messageId: string; turn: Turn }[]
  ): number {
    return this.database.transaction(() => {
      let inserted = 0;
      for (const message of messages) {
        const result = this.database.prepare(`
          INSERT INTO message_receipts(channel_account_id, platform_message_id, received_at, turn_id)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(channel_account_id, platform_message_id) DO NOTHING
        `).run(accountId, message.messageId, acceptedAt, message.turn.id);
        if (result.changes > 0) {
          this.#transaction.putTurn(message.turn);
          inserted += 1;
        }
      }
      this.database.prepare(`
        INSERT INTO channel_cursors(account_id, cursor, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at
      `).run(accountId, cursor, acceptedAt);
      return inserted;
    })();
  }

  public close(): void {
    this.database.close();
  }
}
