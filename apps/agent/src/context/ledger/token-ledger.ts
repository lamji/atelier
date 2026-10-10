import { newId } from "@atelier/shared";
import type {
  ContextPurpose,
  ContextRequestStats,
  ContextTotals,
} from "@atelier/protocol";
import type { Db } from "../../storage/db.js";
import type { EventBus } from "../../events/event-bus.js";

/** Token-usage fields of the SDK result message we account for. */
export interface SdkUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
}

interface LedgerRow {
  id: string;
  task_id: string | null;
  conversation_id: string | null;
  purpose: string;
  sections: string;
  append_tokens: number;
  est_baseline_tokens: number;
  saved_tokens: number;
  actual_input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  output_tokens: number | null;
  cache_hit: number;
  deduped_chunks: number;
  created_at: number;
}

export interface TaskTokenTurn {
  purpose: ContextPurpose;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TaskTokenUsage {
  turns: TaskTokenTurn[];
  totalTokens: number;
}

/**
 * Records what every assembled context cost — estimated at assembly time,
 * reconciled with SDK actuals when the result message arrives — and serves
 * the context.stats RPC plus the live context.stats event.
 */
export class TokenLedger {
  constructor(
    private db: Db,
    private bus: EventBus
  ) {}

  /** Persist stats (insert or update by requestId) and push to the UI. */
  record(stats: ContextRequestStats): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO context_requests(" +
          "id, task_id, conversation_id, purpose, sections, append_tokens, " +
          "est_baseline_tokens, saved_tokens, actual_input_tokens, " +
          "cache_read_tokens, cache_creation_tokens, output_tokens, " +
          "cache_hit, deduped_chunks, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        stats.requestId,
        stats.taskId,
        stats.conversationId,
        stats.purpose,
        JSON.stringify(stats.sections),
        stats.appendTokens,
        stats.estBaselineTokens,
        stats.savedTokens,
        stats.actualInputTokens ?? null,
        stats.cacheReadTokens ?? null,
        stats.cacheCreationTokens ?? null,
        stats.outputTokens ?? null,
        stats.cacheHit ? 1 : 0,
        stats.dedupedChunks,
        stats.at
      );
    this.bus.publish("context.stats", stats, stats.taskId);
  }

  /**
   * Fold SDK actuals into the latest still-open row for this task+purpose,
   * or open a fresh row when nothing was recorded at assembly time (e.g. a
   * fix/review turn with no assembled context block).
   */
  attachSdkUsage(
    taskId: string,
    conversationId: string,
    purpose: ContextPurpose,
    usage: SdkUsage
  ): void {
    const row = this.db
      .prepare(
        "SELECT * FROM context_requests " +
          "WHERE task_id = ? AND purpose = ? AND actual_input_tokens IS NULL " +
          "ORDER BY created_at DESC LIMIT 1"
      )
      .get(taskId, purpose) as LedgerRow | undefined;
    const stats = row
      ? rowToStats(row)
      : emptyStats(taskId, conversationId, purpose);
    stats.actualInputTokens = usage.input_tokens ?? 0;
    stats.cacheReadTokens = usage.cache_read_input_tokens ?? 0;
    stats.cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
    stats.outputTokens = usage.output_tokens ?? 0;
    this.record(stats);
  }

  /** Ordered actual usage for every model request made by one task. */
  taskUsage(taskId: string): TaskTokenUsage {
    const rows = this.db
      .prepare(
        "SELECT * FROM context_requests " +
          "WHERE task_id = ? AND actual_input_tokens IS NOT NULL " +
          "ORDER BY created_at ASC, id ASC"
      )
      .all(taskId) as LedgerRow[];
    const turns = rows.map((row): TaskTokenTurn => {
      const inputTokens = row.actual_input_tokens ?? 0;
      const cacheReadTokens = row.cache_read_tokens ?? 0;
      const cacheCreationTokens = row.cache_creation_tokens ?? 0;
      const outputTokens = row.output_tokens ?? 0;
      return {
        purpose: row.purpose as ContextPurpose,
        inputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        outputTokens,
        totalTokens:
          inputTokens + cacheReadTokens + cacheCreationTokens + outputTokens,
      };
    });
    return {
      turns,
      totalTokens: turns.reduce((sum, turn) => sum + turn.totalTokens, 0),
    };
  }

  /** Recent requests (newest first) plus rollup totals for the RPC. */
  query(
    conversationId?: string,
    limit = 50
  ): { requests: ContextRequestStats[]; totals: ContextTotals } {
    const where = conversationId ? "WHERE conversation_id = ? " : "";
    const args = conversationId ? [conversationId] : [];
    const rows = this.db
      .prepare(
        `SELECT * FROM context_requests ${where}` +
          "ORDER BY created_at DESC LIMIT ?"
      )
      .all(...args, limit) as LedgerRow[];
    const totalsRow = this.db
      .prepare(
        "SELECT COUNT(*) AS requests, " +
          "COALESCE(SUM(actual_input_tokens), 0) AS input, " +
          "COALESCE(SUM(cache_read_tokens), 0) AS cacheRead, " +
          "COALESCE(SUM(saved_tokens), 0) AS saved " +
          `FROM context_requests ${where.trim()}`
      )
      .get(...args) as {
      requests: number;
      input: number;
      cacheRead: number;
      saved: number;
    };
    return {
      requests: rows.map(rowToStats),
      totals: {
        requests: totalsRow.requests,
        actualInputTokens: totalsRow.input,
        cacheReadTokens: totalsRow.cacheRead,
        savedTokens: totalsRow.saved,
      },
    };
  }
}

function rowToStats(row: LedgerRow): ContextRequestStats {
  return {
    requestId: row.id,
    taskId: row.task_id ?? "",
    conversationId: row.conversation_id ?? "",
    purpose: row.purpose as ContextRequestStats["purpose"],
    sections: JSON.parse(row.sections) as ContextRequestStats["sections"],
    appendTokens: row.append_tokens,
    estBaselineTokens: row.est_baseline_tokens,
    savedTokens: row.saved_tokens,
    savedPct:
      row.est_baseline_tokens > 0
        ? Math.round((row.saved_tokens / row.est_baseline_tokens) * 100)
        : 0,
    actualInputTokens: row.actual_input_tokens ?? undefined,
    cacheReadTokens: row.cache_read_tokens ?? undefined,
    cacheCreationTokens: row.cache_creation_tokens ?? undefined,
    outputTokens: row.output_tokens ?? undefined,
    cacheHit: row.cache_hit === 1,
    dedupedChunks: row.deduped_chunks,
    at: row.created_at,
  };
}

function emptyStats(
  taskId: string,
  conversationId: string,
  purpose: ContextPurpose
): ContextRequestStats {
  return {
    requestId: newId("ctxreq"),
    taskId,
    conversationId,
    purpose,
    sections: [],
    appendTokens: 0,
    estBaselineTokens: 0,
    savedTokens: 0,
    savedPct: 0,
    cacheHit: false,
    dedupedChunks: 0,
    at: Date.now(),
  };
}
