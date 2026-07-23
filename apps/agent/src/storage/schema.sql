-- Atelier knowledge + runtime store. Applied idempotently at startup.

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  sdk_session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  task_id TEXT,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conv
  ON chat_messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  topic TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timeline_task ON timeline(task_id, id);
CREATE INDEX IF NOT EXISTS idx_timeline_topic ON timeline(topic, seq);

CREATE TABLE IF NOT EXISTS hook_configs (
  id TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS terminal_history (
  term_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Knowledge engine (populated from Phase 5 on).

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  lang TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  parse_status TEXT NOT NULL DEFAULT 'pending',
  parsed_at INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  signature TEXT,
  parent_symbol_id INTEGER REFERENCES symbols(id),
  start_row INTEGER NOT NULL,
  start_col INTEGER NOT NULL,
  end_row INTEGER NOT NULL,
  end_col INTEGER NOT NULL,
  doc_comment TEXT,
  stable_key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_stable ON symbols(stable_key);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  specifier TEXT NOT NULL,
  resolved_file_id INTEGER REFERENCES files(id),
  imported_names TEXT,
  is_type_only INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_id);
CREATE INDEX IF NOT EXISTS idx_imports_resolved ON imports(resolved_file_id);

CREATE TABLE IF NOT EXISTS exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  exported_name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  re_export_from TEXT
);
CREATE INDEX IF NOT EXISTS idx_exports_file ON exports(file_id);
CREATE INDEX IF NOT EXISTS idx_exports_name ON exports(exported_name);

CREATE TABLE IF NOT EXISTS call_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  callee_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  callee_name TEXT NOT NULL,
  callee_module_hint TEXT,
  site_row INTEGER NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5
);
CREATE INDEX IF NOT EXISTS idx_call_edges_caller ON call_edges(caller_symbol_id);
CREATE INDEX IF NOT EXISTS idx_call_edges_callee ON call_edges(callee_symbol_id);
CREATE INDEX IF NOT EXISTS idx_call_edges_name ON call_edges(callee_name);

CREATE TABLE IF NOT EXISTS symbol_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  row INTEGER NOT NULL,
  col INTEGER NOT NULL,
  ref_kind TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS features (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL DEFAULT '',
  detail_md TEXT,
  status TEXT NOT NULL DEFAULT 'building',
  model_version TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feature_files (
  feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  weight REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (feature_id, file_id)
);

CREATE TABLE IF NOT EXISTS feature_symbols (
  feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  role TEXT,
  PRIMARY KEY (feature_id, symbol_id)
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
  symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  start_row INTEGER,
  end_row INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);

-- Embeddings stored as BLOB (JS cosine fallback); sqlite-vec virtual table is
-- created at runtime when the extension loads successfully.
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  dims INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS index_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  enqueued_at INTEGER NOT NULL,
  started_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_index_jobs_status
  ON index_jobs(status, priority DESC, id);

CREATE TABLE IF NOT EXISTS test_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  kind TEXT NOT NULL,
  ok INTEGER NOT NULL,
  findings TEXT NOT NULL DEFAULT '[]',
  ran_at INTEGER NOT NULL
);
