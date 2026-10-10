import type { CliHistoryEntry } from "@atelier/protocol";
import type { Db } from "../db.js";

interface HistoryRow {
  provider_id: string;
  session_id: string;
  workspace_root: string;
  title: string;
  custom_title: string | null;
  started_at: number;
  updated_at: number;
}

/** Durable index of provider-owned transcripts. The transcript stays the source of context. */
export class CliSessionHistoryRepo {
  constructor(private db: Db) {}

  save(entries: CliHistoryEntry[], workspaceRoot: string): void {
    const upsert = this.db.prepare(
      "INSERT INTO cli_session_history(provider_id, session_id, workspace_root, title, started_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider_id, session_id, workspace_root) DO UPDATE SET " +
        "title = CASE WHEN excluded.title != '' THEN excluded.title ELSE title END, " +
        "started_at = CASE WHEN excluded.started_at > 0 THEN excluded.started_at ELSE started_at END, " +
        "updated_at = MAX(updated_at, excluded.updated_at)"
    );
    this.db.transaction(() => {
      for (const entry of entries) {
        upsert.run(
          entry.providerId,
          entry.id,
          workspaceRoot,
          entry.title,
          entry.startedAt,
          entry.updatedAt
        );
      }
    })();
  }

  setCustomTitle(providerId: string, sessionId: string, workspaceRoot: string, title: string): void {
    this.db.prepare(
      "INSERT INTO cli_session_history(" +
        "provider_id, session_id, workspace_root, title, custom_title, started_at, updated_at) " +
        "VALUES (?, ?, ?, '', ?, 0, ?) ON CONFLICT(provider_id, session_id, workspace_root) " +
        "DO UPDATE SET custom_title = excluded.custom_title"
    ).run(providerId, sessionId, workspaceRoot, title, Date.now());
  }

  list(workspaceRoot: string, providerId?: string, limit = 250): CliHistoryEntry[] {
    const rows = this.db.prepare(
      "SELECT provider_id, session_id, workspace_root, title, custom_title, started_at, updated_at " +
        "FROM cli_session_history WHERE workspace_root = ? " +
        (providerId ? "AND provider_id = ? " : "") +
        "ORDER BY updated_at DESC LIMIT ?"
    ).all(...(providerId ? [workspaceRoot, providerId, limit] : [workspaceRoot, limit])) as HistoryRow[];
    return rows.map((row) => ({
      id: row.session_id,
      providerId: row.provider_id,
      title: row.custom_title ?? row.title,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      cwd: row.workspace_root,
    }));
  }

  count(workspaceRoot: string, providerId?: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS total FROM cli_session_history WHERE workspace_root = ? " +
        (providerId ? "AND provider_id = ?" : "")
    ).get(...(providerId ? [workspaceRoot, providerId] : [workspaceRoot])) as { total: number };
    return row.total;
  }
}
