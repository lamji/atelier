import crypto from "node:crypto";
import type { Db } from "../../storage/db.js";
import type { Embedder } from "../../knowledge/embeddings/embedder.js";
import type { VectorStore } from "../../knowledge/embeddings/vector-store.js";

/** One retrievable unit of work inside a task. */
export interface SessionDetail {
  title: string;
  files: string[];
  /** Free text (e.g. the tail of interrupted work), when there is any. */
  body?: string;
}

export interface TaskSummary {
  taskId: string;
  conversationId: string;
  text: string;
  changedFiles: string[];
  outcome: string | null;
  /** How the task ended; an interrupted task is still remembered. */
  status?: "completed" | "cancelled" | "error";
  /** Finer-grained units, each stored as its own retrievable chunk. */
  details?: SessionDetail[];
  chunkId?: number | null;
  createdAt: number;
}

/**
 * Conversation memory: compressed per-task outcomes. Later tasks receive
 * these few lines instead of raw prior turns, and RAG can pull a single
 * detail out of a long session because each unit of work is its own chunk.
 *
 * None of this is provider-specific by design — it is what lets a switch
 * from Claude to Codex to Ollama continue the same thread.
 */
export class TaskSummaryStore {
  constructor(
    private db: Db,
    private embedder?: Embedder,
    private vectors?: VectorStore,
    /** Invalidates caches keyed on the index generation after a write. */
    private onWrite?: () => void
  ) {}

  async save(summary: TaskSummary): Promise<void> {
    const existing = this.db
      .prepare("SELECT chunk_id FROM task_summaries WHERE task_id = ?")
      .get(summary.taskId) as { chunk_id: number | null } | undefined;
    const overviewText = overviewChunkText(summary);
    const chunkId = this.upsertChunk(overviewText, existing?.chunk_id ?? null);
    this.db
      .prepare(
        "INSERT OR REPLACE INTO task_summaries(" +
          "task_id, conversation_id, text, changed_files, outcome, status, " +
          "chunk_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        summary.taskId,
        summary.conversationId,
        summary.text,
        JSON.stringify(summary.changedFiles),
        summary.outcome,
        summary.status ?? "completed",
        chunkId,
        summary.createdAt
      );

    const texts = this.writeSessionChunks(summary, chunkId, overviewText);
    for (const [id, text] of texts) await this.embedChunk(id, text);
    // A new memory must be visible to the very next retrieval; the retrieval
    // cache is keyed on the index generation, which only file indexing bumps.
    this.onWrite?.();
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
      status: string | null;
      chunk_id: number | null;
      created_at: number;
    }>;
    return rows.map((r) => ({
      taskId: r.task_id,
      conversationId: r.conversation_id,
      text: r.text,
      changedFiles: JSON.parse(r.changed_files) as string[],
      outcome: r.outcome,
      status: (r.status ?? "completed") as TaskSummary["status"],
      chunkId: r.chunk_id,
      createdAt: r.created_at,
    }));
  }

  /**
   * Which tasks the given chunks belong to. Lets the caller drop summaries
   * that retrieval already surfaced instead of sending them twice.
   */
  taskIdsForChunks(chunkIds: number[]): string[] {
    if (chunkIds.length === 0) return [];
    const placeholders = chunkIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT DISTINCT task_id FROM session_chunks WHERE chunk_id IN (${placeholders}) ` +
          `UNION SELECT task_id FROM task_summaries WHERE chunk_id IN (${placeholders})`
      )
      .all(...chunkIds, ...chunkIds) as Array<{ task_id: string }>;
    return rows.map((r) => r.task_id);
  }

  /**
   * Rewrites this task's session-memory chunk set: the overview at ord 0 plus
   * one chunk per detail. Returns [chunkId, text] for everything that needs
   * an embedding.
   */
  private writeSessionChunks(
    summary: TaskSummary,
    overviewChunkId: number,
    overviewText: string
  ): Array<[number, string]> {
    // Detail chunks are rebuilt wholesale — the set can shrink between saves
    // (an interrupted task re-saved on completion), and a stale detail would
    // otherwise keep matching queries forever.
    const stale = this.db
      .prepare("SELECT chunk_id FROM session_chunks WHERE task_id = ? AND ord > 0")
      .all(summary.taskId) as Array<{ chunk_id: number }>;
    for (const row of stale) {
      // session_chunks + chunk_embeddings both cascade from chunks(id).
      this.db.prepare("DELETE FROM chunks WHERE id = ?").run(row.chunk_id);
    }

    const link = this.db.prepare(
      "INSERT OR REPLACE INTO session_chunks(" +
        "task_id, conversation_id, ord, chunk_id, created_at) VALUES (?, ?, ?, ?, ?)"
    );
    link.run(
      summary.taskId,
      summary.conversationId,
      0,
      overviewChunkId,
      summary.createdAt
    );

    const written: Array<[number, string]> = [[overviewChunkId, overviewText]];
    const details = summary.details ?? [];
    for (let i = 0; i < details.length; i++) {
      const text = detailChunkText(summary, details[i]!);
      const chunkId = this.upsertChunk(text, null);
      link.run(
        summary.taskId,
        summary.conversationId,
        i + 1,
        chunkId,
        summary.createdAt
      );
      written.push([chunkId, text]);
    }
    return written;
  }

  private upsertChunk(text: string, existingChunkId: number | null): number {
    const hash = sha1(`session-memory:${text}`);
    const tokens = Math.ceil(text.length / 4);
    if (existingChunkId) {
      this.db
        .prepare(
          "UPDATE chunks SET content_hash = ?, text = ?, token_count = ? " +
            "WHERE id = ?"
        )
        .run(hash, text, tokens, existingChunkId);
      return existingChunkId;
    }
    const info = this.db
      .prepare(
        "INSERT INTO chunks(file_id, symbol_id, kind, content_hash, text, token_count) " +
          "VALUES (NULL, NULL, 'session-memory', ?, ?, ?)"
      )
      .run(hash, text, tokens);
    return Number(info.lastInsertRowid);
  }

  private async embedChunk(chunkId: number, text: string): Promise<void> {
    if (!this.embedder || !this.vectors) return;
    const [vec] = await this.embedder.embed([text]);
    if (vec) this.vectors.upsert(chunkId, vec);
  }
}

function overviewChunkText(summary: TaskSummary): string {
  const lines = [
    "SESSION MEMORY",
    `Conversation: ${summary.conversationId}`,
    `Task: ${summary.taskId}`,
    `Summary: ${summary.text}`,
  ];
  if (summary.changedFiles.length > 0) {
    lines.push(`Changed files: ${summary.changedFiles.join(", ")}`);
  }
  if (summary.outcome) lines.push(`Outcome: ${summary.outcome}`);
  if (summary.status && summary.status !== "completed") {
    lines.push(`Status: ${summary.status}`);
  }
  return lines.join("\n");
}

/**
 * A detail chunk carries its own frame — retrieval may return it ALONE, with
 * no overview beside it, so "which task was this?" has to be answerable from
 * the chunk itself.
 */
function detailChunkText(summary: TaskSummary, detail: SessionDetail): string {
  const lines = [
    "SESSION MEMORY (detail)",
    `Conversation: ${summary.conversationId}`,
    `Task: ${summary.taskId}`,
    `Work: ${detail.title}`,
  ];
  if (detail.files.length > 0) lines.push(`Files: ${detail.files.join(", ")}`);
  if (detail.body) lines.push(detail.body);
  lines.push(`Part of: ${summary.text}`);
  return lines.join("\n");
}

function sha1(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}
