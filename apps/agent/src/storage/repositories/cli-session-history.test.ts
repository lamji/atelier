import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openDb } from "../db.js";
import { CliSessionHistoryRepo } from "./cli-session-history.js";

test("CLI history keeps provider session IDs across scans and workspace filters", () => {
  const db = new Database(":memory:");
  try {
    db.exec(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "schema.sql"), "utf8"));
    const history = new CliSessionHistoryRepo(db);
    history.save([
      { id: "old", providerId: "claude", title: "Original context", startedAt: 10, updatedAt: 20, cwd: "one" },
      { id: "new", providerId: "codex", title: "New context", startedAt: 30, updatedAt: 40, cwd: "one" },
    ], "one");
    history.save([
      { id: "old", providerId: "claude", title: "", startedAt: 10, updatedAt: 50, cwd: "one" },
    ], "one");
    history.save([
      { id: "other", providerId: "claude", title: "Other project", startedAt: 60, updatedAt: 70, cwd: "two" },
    ], "two");
    history.setCustomTitle("claude", "old", "one", "Updated from session context");
    history.save([
      { id: "old", providerId: "claude", title: "Original context", startedAt: 10, updatedAt: 80, cwd: "one" },
    ], "one");

    const reopened = new CliSessionHistoryRepo(db);
    assert.deepEqual(reopened.list("one").map((entry) => entry.id), ["old", "new"]);
    assert.equal(reopened.list("one", "claude")[0]?.title, "Updated from session context");
    assert.deepEqual(reopened.list("two").map((entry) => entry.id), ["other"]);
    assert.equal(reopened.count("one"), 2);
    assert.equal(reopened.count("one", "claude"), 1);
  } finally {
    db.close();
  }
});

test("existing CLI history databases gain the custom title column", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "atelier-cli-history-"));
  try {
    const legacy = new Database(path.join(dir, "atelier.db"));
    legacy.exec(
      "CREATE TABLE cli_session_history (" +
      "provider_id TEXT NOT NULL, session_id TEXT NOT NULL, workspace_root TEXT NOT NULL, " +
      "title TEXT NOT NULL, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, " +
      "PRIMARY KEY (provider_id, session_id, workspace_root))"
    );
    legacy.close();
    const db = openDb(dir);
    try {
      const columns = db.prepare("PRAGMA table_info(cli_session_history)")
        .all() as Array<{ name: string }>;
      assert.ok(columns.some((column) => column.name === "custom_title"));
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
