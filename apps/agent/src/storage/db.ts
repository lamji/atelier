import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Db = Database.Database;

const SCHEMA_VERSION = "1";

export function openDb(dataDir: string): Db {
  const file = path.join(dataDir, "atelier.db");
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

function applySchema(db: Db): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schema = fs.readFileSync(path.join(here, "schema.sql"), "utf8");
  db.exec(schema);
  applyMigrations(db);
  db.prepare(
    "INSERT INTO meta(key, value) VALUES('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(SCHEMA_VERSION);
}

/** Additive migrations for DBs created before a column existed. */
function applyMigrations(db: Db): void {
  const columns = (
    db.prepare("PRAGMA table_info(features)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!columns.includes("chunk_id")) {
    db.exec("ALTER TABLE features ADD COLUMN chunk_id INTEGER REFERENCES chunks(id)");
  }
  const messageColumns = (
    db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!messageColumns.includes("meta")) {
    db.exec("ALTER TABLE chat_messages ADD COLUMN meta TEXT");
  }
  const summaryColumns = (
    db.prepare("PRAGMA table_info(task_summaries)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!summaryColumns.includes("chunk_id")) {
    db.exec("ALTER TABLE task_summaries ADD COLUMN chunk_id INTEGER REFERENCES chunks(id)");
  }
  if (!summaryColumns.includes("status")) {
    db.exec(
      "ALTER TABLE task_summaries ADD COLUMN status TEXT NOT NULL " +
        "DEFAULT 'completed'"
    );
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_task_summaries_chunk " +
      "ON task_summaries(chunk_id)"
  );
  // Session memory used to be one chunk per task, addressed by
  // task_summaries.chunk_id. Backfill those as ord-0 rows so retrieval has a
  // single source of truth and old conversations stay recallable.
  db.exec(
    "INSERT OR IGNORE INTO session_chunks(" +
      "task_id, conversation_id, ord, chunk_id, created_at) " +
      "SELECT task_id, conversation_id, 0, chunk_id, created_at " +
      "FROM task_summaries WHERE chunk_id IS NOT NULL"
  );
  // Backfill the durable source mapping for databases that briefly used only
  // global_sessions.source_conversation_id during the experiment.
  db.exec(
    "INSERT OR IGNORE INTO global_session_sources(" +
      "conversation_id, global_session_id, linked_at) " +
      "SELECT source_conversation_id, id, created_at FROM global_sessions"
  );
  createChunkSearchIndex(db);
}

/** Name of the full-text index over chunk text. Also read by the retriever. */
export const CHUNKS_FTS = "chunks_fts";

/** `meta` key recording that the index has been populated, and at what shape. */
const FTS_BUILT_KEY = "chunks_fts_built";

/** Bump to force a rebuild when the tokenizer or indexed columns change. */
const FTS_VERSION = "1-trigram";

/**
 * Full-text index over chunk text, for retrieval's keyword arm.
 *
 * Without it that arm is `lower(text) LIKE '%term%'` against every chunk in
 * the database, once per extracted term, on a synchronous driver — so it
 * scans the whole corpus up to six times per query while holding the event
 * loop that is streaming tokens to the UI.
 *
 * The tokenizer is `trigram` specifically, not the default: code queries
 * mean substring matches INSIDE identifiers ("user" finding `getUserById`),
 * which a word tokenizer cannot do and which is exactly what the LIKE was
 * buying. Trigram indexes that same match, case-insensitively.
 *
 * Built here rather than in schema.sql, and inside a try: schema.sql runs on
 * every open, so an FTS5-less build would fail to open the database at all
 * instead of quietly falling back to the scan the way retrieval expects.
 */
function createChunkSearchIndex(db: Db): void {
  try {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${CHUNKS_FTS} USING fts5(` +
        "text, content='chunks', content_rowid='id', tokenize='trigram');" +
        // External content: the triggers ARE the sync mechanism.
        `CREATE TRIGGER IF NOT EXISTS ${CHUNKS_FTS}_ai AFTER INSERT ON chunks ` +
        `BEGIN INSERT INTO ${CHUNKS_FTS}(rowid, text) ` +
        "VALUES (new.id, new.text); END;" +
        `CREATE TRIGGER IF NOT EXISTS ${CHUNKS_FTS}_ad AFTER DELETE ON chunks ` +
        `BEGIN INSERT INTO ${CHUNKS_FTS}(${CHUNKS_FTS}, rowid, text) ` +
        "VALUES ('delete', old.id, old.text); END;" +
        `CREATE TRIGGER IF NOT EXISTS ${CHUNKS_FTS}_au AFTER UPDATE ON chunks ` +
        `BEGIN INSERT INTO ${CHUNKS_FTS}(${CHUNKS_FTS}, rowid, text) ` +
        "VALUES ('delete', old.id, old.text); " +
        `INSERT INTO ${CHUNKS_FTS}(rowid, text) ` +
        "VALUES (new.id, new.text); END;"
    );
    // An install that already had chunks needs one rebuild — the triggers
    // above only see writes made after they exist.
    //
    // Whether that rebuild has happened is recorded in `meta`, deliberately,
    // because there is no cheap way to ask the table: `count(*)` on an
    // external-content FTS5 table scans the CONTENT table, so it reports
    // every chunk as indexed the moment the vtable exists, whether or not a
    // single trigram was ever written. Trusting it silently produced an
    // index that matched nothing.
    const built = db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(FTS_BUILT_KEY) as { value: string } | undefined;
    if (built?.value !== FTS_VERSION) {
      db.exec(`INSERT INTO ${CHUNKS_FTS}(${CHUNKS_FTS}) VALUES('rebuild')`);
      db.prepare(
        "INSERT INTO meta(key, value) VALUES(?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(FTS_BUILT_KEY, FTS_VERSION);
    }
  } catch {
    // No FTS5 in this build. Retrieval checks for the table and falls back.
  }
}

/** True when the keyword arm can use the index instead of scanning. */
export function hasChunkSearchIndex(db: Db): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(CHUNKS_FTS) as { name: string } | undefined;
  return row !== undefined;
}
