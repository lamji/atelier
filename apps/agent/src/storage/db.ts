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
  db.prepare(
    "INSERT INTO meta(key, value) VALUES('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(SCHEMA_VERSION);
}
