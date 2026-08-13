import type { CliSessionChange } from "@atelier/protocol";
import type { Db } from "../db.js";

interface CliSessionDiffRow {
  path: string;
  before_content: string;
  after_content: string;
  first_touched_at: number;
  last_touched_at: number;
  also_touched_by: string;
}

/** SQLite access for durable provider-session review data. */
export class CliSessionDiffRepo {
  constructor(private db: Db) {}

  get(providerId: string, sessionId: string): CliSessionChange[] {
    const rows = this.db
      .prepare(
        "SELECT path, before_content, after_content, first_touched_at, " +
          "last_touched_at, also_touched_by FROM cli_session_diffs " +
          "WHERE provider_id = ? AND session_id = ? " +
          "ORDER BY last_touched_at DESC, path"
      )
      .all(providerId, sessionId) as CliSessionDiffRow[];

    return rows.map((row) => ({
      path: row.path,
      before: row.before_content,
      after: row.after_content,
      firstTouchedAt: row.first_touched_at,
      lastTouchedAt: row.last_touched_at,
      alsoTouchedBy: parseStringArray(row.also_touched_by),
    }));
  }

  save(
    providerId: string,
    sessionId: string,
    changes: CliSessionChange[]
  ): void {
    const upsert = this.db.prepare(
      "INSERT INTO cli_session_diffs(" +
        "provider_id, session_id, path, before_content, after_content, " +
        "first_touched_at, last_touched_at, also_touched_by) " +
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(provider_id, session_id, path) DO UPDATE SET " +
        "before_content = excluded.before_content, " +
        "after_content = excluded.after_content, " +
        "first_touched_at = MIN(first_touched_at, excluded.first_touched_at), " +
        "last_touched_at = excluded.last_touched_at, " +
        "also_touched_by = excluded.also_touched_by"
    );
    const saveAll = this.db.transaction(() => {
      for (const change of changes) {
        upsert.run(
          providerId,
          sessionId,
          change.path,
          change.before,
          change.after,
          change.firstTouchedAt,
          change.lastTouchedAt,
          JSON.stringify(change.alsoTouchedBy)
        );
      }
    });
    saveAll();
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}
