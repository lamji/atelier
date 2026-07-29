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
}
