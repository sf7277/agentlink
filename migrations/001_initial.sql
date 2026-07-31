CREATE TABLE channel_accounts (
  id TEXT PRIMARY KEY,
  channel_kind TEXT NOT NULL,
  credential_ref TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE channel_users (
  account_id TEXT NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL,
  gateway_user_id TEXT NOT NULL,
  PRIMARY KEY (account_id, sender_id)
);

CREATE TABLE channel_cursors (
  account_id TEXT PRIMARY KEY REFERENCES channel_accounts(id) ON DELETE CASCADE,
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE message_receipts (
  channel_account_id TEXT NOT NULL,
  platform_message_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  turn_id TEXT,
  PRIMARY KEY (channel_account_id, platform_message_id)
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  channel_account_id TEXT NOT NULL,
  platform_conversation_id TEXT NOT NULL,
  UNIQUE (channel_account_id, platform_conversation_id)
);

CREATE TABLE conversation_bindings (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  session_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  canonical_path TEXT NOT NULL UNIQUE,
  allowed_agents_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  agent_kind TEXT NOT NULL,
  native_session_id TEXT,
  runtime_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('CREATING', 'OPEN', 'CLOSING', 'CLOSED', 'UNKNOWN')),
  runtime_state TEXT NOT NULL CHECK (runtime_state IN ('STARTING', 'ALIVE', 'EXITED', 'UNKNOWN')),
  queue_paused INTEGER NOT NULL DEFAULT 0 CHECK (queue_paused IN (0, 1)),
  display_name TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (agent_kind, native_session_id)
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN (
    'RECEIVED', 'QUEUED', 'PAUSED', 'DISPATCHED', 'RUNNING',
    'WAITING_AGENT_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN'
  )),
  input_sequence INTEGER NOT NULL CHECK (input_sequence > 0),
  queue_sequence INTEGER CHECK (queue_sequence > 0),
  source_endpoint_id TEXT NOT NULL,
  text TEXT NOT NULL,
  native_turn_id TEXT,
  final_response TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (session_id, input_sequence),
  UNIQUE (session_id, queue_sequence)
);

CREATE TABLE turn_inputs (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  input_sequence INTEGER NOT NULL,
  source_endpoint_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('initial', 'steer')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (turn_id, input_sequence)
);

CREATE TABLE approval_audit (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  turn_id TEXT NOT NULL REFERENCES turns(id),
  action_digest TEXT NOT NULL,
  decision TEXT,
  observed_state TEXT NOT NULL,
  created_at TEXT NOT NULL
);
