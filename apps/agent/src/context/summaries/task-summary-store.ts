import type { Db } from "../../storage/db.js";

export interface TaskSummary {
  taskId: string;
  conversationId: string;
  text: string;
  changedFiles: string[];
  outcome: string | null;
  createdAt: number;
}

/**
 * Conversation memory: compressed per-task outcomes. Later tasks receive
 * these few lines instead of raw prior turns — the SDK transcript still
 * exists, but Atelier's own context block never replays history.
 */
export class TaskSummaryStore {
  constructor(private db: Db) {}

  save(summary: TaskSummary): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO task_summaries(" +
          "task_id, conversation_id, text, changed_files, outcome, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        summary.taskId,
        summary.conversationId,
        summary.text,
        JSON.stringify(summary.changedFiles),
        summary.outcome,
        summary.createdAt
      );
  }

  recent(conversationId: string, n: number): TaskSummary[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM task_summaries WHERE conversation_id = ? " +
          "ORDER BY created_at DESC LIMIT ?"
      )
      .all(conversationId, n) as Array<{
      task_id: string;
      conversation_id: string;
      text: string;
      changed_files: string;
      outcome: string | null;
      created_at: number;
    }>;
    return rows.map((r) => ({
      taskId: r.task_id,
      conversationId: r.conversation_id,
      text: r.text,
      changedFiles: JSON.parse(r.changed_files) as string[],
      outcome: r.outcome,
      createdAt: r.created_at,
    }));
  }
}
