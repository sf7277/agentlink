ALTER TABLE agent_sessions
  ADD COLUMN native_lifecycle_owner TEXT NOT NULL DEFAULT 'AGENTLINK'
  CHECK (native_lifecycle_owner IN ('AGENTLINK', 'EXTERNAL'));

ALTER TABLE projects
  ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1
  CHECK (enabled IN (0, 1));

ALTER TABLE channel_accounts
  ADD COLUMN credential_status TEXT NOT NULL DEFAULT 'UNKNOWN'
  CHECK (credential_status IN ('HEALTHY', 'AUTHENTICATION_REQUIRED', 'DISABLED', 'UNKNOWN'));

ALTER TABLE channel_accounts ADD COLUMN authentication_failure_at TEXT;
ALTER TABLE channel_accounts ADD COLUMN disabled_at TEXT;
