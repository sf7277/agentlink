import type Database from "better-sqlite3";
import type {
  ApprovalAuditPort,
  ApprovalAuditRecord
} from "../core/contracts/ports.js";

export class ControlRepository implements ApprovalAuditPort {
  public constructor(private readonly database: Database.Database) {}

  public bindConversation(
    conversationId: string,
    accountId: string,
    platformConversationId: string,
    sessionId: string | undefined,
    updatedAt: string
  ): void {
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO conversations(id, channel_account_id, platform_conversation_id)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          channel_account_id = excluded.channel_account_id,
          platform_conversation_id = excluded.platform_conversation_id
      `).run(conversationId, accountId, platformConversationId);
      this.database.prepare(`
        INSERT INTO conversation_bindings(conversation_id, session_id, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          session_id = excluded.session_id,
          updated_at = excluded.updated_at
      `).run(conversationId, sessionId ?? null, updatedAt);
    })();
  }

  public activeSessionFor(conversationId: string): string | undefined {
    const row = this.database.prepare(`
      SELECT session_id FROM conversation_bindings WHERE conversation_id = ?
    `).get(conversationId) as { session_id: string | null } | undefined;
    return row?.session_id ?? undefined;
  }

  public acceptMessageReceipt(accountId: string, messageId: string, receivedAt: string): boolean {
    return this.database.prepare(`
      INSERT INTO message_receipts(channel_account_id, platform_message_id, received_at)
      VALUES (?, ?, ?)
      ON CONFLICT(channel_account_id, platform_message_id) DO NOTHING
    `).run(accountId, messageId, receivedAt).changes === 1;
  }

  public putChannelAccount(
    accountId: string,
    credentialReference: string,
    users: readonly { senderId: string; gatewayUserId: string }[],
    createdAt: string
  ): void {
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO channel_accounts(id, channel_kind, credential_ref, created_at)
        VALUES (?, 'wechat-ilink', ?, ?)
        ON CONFLICT(id) DO UPDATE SET credential_ref = excluded.credential_ref
      `).run(accountId, credentialReference, createdAt);
      const putUser = this.database.prepare(`
        INSERT INTO channel_users(account_id, sender_id, gateway_user_id)
        VALUES (?, ?, ?)
        ON CONFLICT(account_id, sender_id) DO UPDATE SET
          gateway_user_id = excluded.gateway_user_id
      `);
      for (const user of users) putUser.run(accountId, user.senderId, user.gatewayUserId);
    })();
  }

  public cursorFor(accountId: string): string | undefined {
    return (this.database.prepare(
      "SELECT cursor FROM channel_cursors WHERE account_id = ?"
    ).get(accountId) as { cursor: string } | undefined)?.cursor;
  }

  public saveCursor(accountId: string, cursor: string, updatedAt: string): void {
    this.database.prepare(`
      INSERT INTO channel_cursors(account_id, cursor, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at
      WHERE channel_cursors.cursor <> excluded.cursor
    `).run(accountId, cursor, updatedAt);
  }

  public setCredentialStatus(
    accountId: string,
    status: "HEALTHY" | "AUTHENTICATION_REQUIRED" | "DISABLED" | "UNKNOWN",
    at: string
  ): void {
    this.database.prepare(`
      UPDATE channel_accounts SET
        credential_status = ?,
        authentication_failure_at = CASE
          WHEN ? = 'AUTHENTICATION_REQUIRED' THEN ?
          ELSE authentication_failure_at
        END,
        disabled_at = CASE WHEN ? = 'DISABLED' THEN ? ELSE disabled_at END
      WHERE id = ?
    `).run(status, status, at, status, at, accountId);
  }

  public credentialStatus(accountId: string): string | undefined {
    return (this.database.prepare(`
      SELECT credential_status FROM channel_accounts WHERE id = ?
    `).get(accountId) as { credential_status: string } | undefined)?.credential_status;
  }

  public platformConversationForSession(sessionId: string): string | undefined {
    return (this.database.prepare(`
      SELECT conversations.platform_conversation_id
      FROM conversation_bindings
      JOIN conversations ON conversations.id = conversation_bindings.conversation_id
      WHERE conversation_bindings.session_id = ?
      ORDER BY conversation_bindings.updated_at DESC
      LIMIT 1
    `).get(sessionId) as { platform_conversation_id: string } | undefined)
      ?.platform_conversation_id;
  }

  public appendApprovalAudit(record: ApprovalAuditRecord): void {
    this.database.prepare(`
      INSERT INTO approval_audit(
        id, session_id, turn_id, action_digest, decision, observed_state, created_at
      ) VALUES (@id, @sessionId, @turnId, @actionDigest, @decision, @observedState, @createdAt)
    `).run({ ...record, decision: record.decision ?? null });
  }
}
