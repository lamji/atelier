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
  created_at INTEGER NOT NULL,
  -- JSON blob for role-specific extras: { logTopic } or { diff: {...} }.
  meta TEXT
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
  chunk_id INTEGER REFERENCES chunks(id) ON DELETE SET NULL,
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

-- Episodic knowledge: distilled lessons from past work (confirmed bug
-- fixes, gotchas, patterns). Tiny rows; the lesson text lives as a chunk
-- (kind 'lesson', file_id NULL so file re-indexing never wipes it) and is
-- retrieved through the normal RAG arms.
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'gotcha',
  task_id TEXT,
  chunk_id INTEGER REFERENCES chunks(id) ON DELETE SET NULL,
  confidence REAL NOT NULL DEFAULT 0.7,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

-- Links anchor lessons to code. stable_key survives re-indexing (same
-- mechanism that preserves symbol ids); file_path survives file renames
-- of ids while staying human-readable.
CREATE TABLE IF NOT EXISTS lesson_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  stable_key TEXT,
  symbol_name TEXT,
  file_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_lesson_links_lesson ON lesson_links(lesson_id);
CREATE INDEX IF NOT EXISTS idx_lesson_links_key ON lesson_links(stable_key);
CREATE INDEX IF NOT EXISTS idx_lesson_links_path ON lesson_links(file_path);

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

-- Context engineering: per-LLM-request token accounting. Estimated at
-- assembly time, reconciled with SDK actuals when the result arrives.
CREATE TABLE IF NOT EXISTS context_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  conversation_id TEXT,
  purpose TEXT NOT NULL,
  sections TEXT NOT NULL DEFAULT '[]',
  append_tokens INTEGER NOT NULL DEFAULT 0,
  est_baseline_tokens INTEGER NOT NULL DEFAULT 0,
  saved_tokens INTEGER NOT NULL DEFAULT 0,
  actual_input_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  output_tokens INTEGER,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  deduped_chunks INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_requests_conv
  ON context_requests(conversation_id, created_at);

-- Chunks already sent to a conversation at full detail, keyed by content
-- hash so re-indexing (which churns chunk ids) never confuses dedup.
CREATE TABLE IF NOT EXISTS context_sent_chunks (
  conversation_id TEXT NOT NULL,
  chunk_hash TEXT NOT NULL,
  path TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, chunk_hash)
);

-- What the agent already looked at in a conversation: files it read (with
-- the range and a hash of what it saw) and searches it ran. Replayed into
-- the next turn as "previously gathered context" so a follow-up does not
-- start by re-reading what the last turn already gathered.
CREATE TABLE IF NOT EXISTS conversation_working_memory (
  conversation_id TEXT NOT NULL,
  -- 'read' | 'search'
  kind TEXT NOT NULL,
  -- read: "<path>#<offset>-<limit>"; search: "<tool>:<query>"
  key TEXT NOT NULL,
  task_id TEXT NOT NULL,
  -- JSON: read {path, offset, limit, hash, chars}; search {tool, query, paths}
  meta TEXT NOT NULL,
  noted_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, kind, key)
);
CREATE INDEX IF NOT EXISTS idx_working_memory_conv
  ON conversation_working_memory(conversation_id, noted_at);

-- Compressed per-task outcomes ("conversation memory"): injected into
-- later tasks instead of replaying raw history.
CREATE TABLE IF NOT EXISTS task_summaries (
  task_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  text TEXT NOT NULL,
  changed_files TEXT NOT NULL DEFAULT '[]',
  outcome TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  chunk_id INTEGER REFERENCES chunks(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_summaries_conv
  ON task_summaries(conversation_id, created_at);

-- Retrievable session memory: one row per session-memory chunk a task
-- produced. A task writes an overview chunk (ord 0) plus one chunk per unit
-- of work, so RAG can surface the ONE relevant detail from a long session
-- instead of a whole-task digest. Deliberately conversation-scoped: the
-- retriever filters on this column so another chat can never leak in.
CREATE TABLE IF NOT EXISTS session_chunks (
  task_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_session_chunks_conv
  ON session_chunks(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_chunks_chunk
  ON session_chunks(chunk_id);

-- Experimental cross-session memory. A promoted conversation owns one stable
-- record; alias_norm also lets a later session deliberately update the same
-- flow by reusing its alias. Its chunks are separate from session_chunks so
-- ordinary same-session recall can never leak across conversations.
CREATE TABLE IF NOT EXISTS global_sessions (
  id TEXT PRIMARY KEY,
  alias TEXT NOT NULL,
  alias_norm TEXT NOT NULL UNIQUE,
  source_conversation_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_global_sessions_source
  ON global_sessions(source_conversation_id);

-- Every conversation ever merged into a global flow retains the mapping.
-- There is intentionally no FK to conversations: promoted memory survives
-- deletion of its source chat and can still be updated through another source.
CREATE TABLE IF NOT EXISTS global_session_sources (
  conversation_id TEXT PRIMARY KEY,
  global_session_id TEXT NOT NULL
    REFERENCES global_sessions(id) ON DELETE CASCADE,
  linked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_global_session_sources_global
  ON global_session_sources(global_session_id);

CREATE TABLE IF NOT EXISTS global_session_chunks (
  global_session_id TEXT NOT NULL
    REFERENCES global_sessions(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (global_session_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_global_session_chunks_chunk
  ON global_session_chunks(chunk_id);

-- The working-set lock for one conversation. Mentioning a folder ("@app/")
-- narrows retrieval, tools and git to that checkout, and the lock is
-- STICKY: a follow-up carries no path of its own, so without a stored row
-- the second turn would silently widen back to the whole workspace.
-- anchors are the files already touched, used to resolve a bare "fix it".
CREATE TABLE IF NOT EXISTS conversation_scope (
  conversation_id TEXT PRIMARY KEY
    REFERENCES conversations(id) ON DELETE CASCADE,
  roots TEXT NOT NULL,
  anchors TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Durable review data for provider-owned CLI sessions. A PTY id is temporary;
-- provider_id + session_id is the identity used by codex/claude resume.
CREATE TABLE IF NOT EXISTS cli_session_diffs (
  provider_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  before_content TEXT NOT NULL,
  after_content TEXT NOT NULL,
  first_touched_at INTEGER NOT NULL,
  last_touched_at INTEGER NOT NULL,
  also_touched_by TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (provider_id, session_id, path)
);
CREATE INDEX IF NOT EXISTS idx_cli_session_diffs_session
  ON cli_session_diffs(provider_id, session_id, last_touched_at DESC);
