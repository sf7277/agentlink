ALTER TABLE agent_sessions ADD COLUMN source_native_session_id TEXT;
ALTER TABLE agent_sessions ADD COLUMN history_truncated INTEGER NOT NULL DEFAULT 0
  CHECK (history_truncated IN (0, 1));

UPDATE agent_sessions
SET source_native_session_id = native_session_id
WHERE native_lifecycle_owner = 'EXTERNAL' AND native_session_id IS NOT NULL;

CREATE UNIQUE INDEX agent_sessions_agent_source_native_unique
  ON agent_sessions(agent_kind, source_native_session_id)
  WHERE source_native_session_id IS NOT NULL;
