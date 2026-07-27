import type { RetrievedChunk } from "@atelier/protocol";
import type { Db } from "../../storage/db.js";

/**
 * Cross-turn dedup ledger: which chunk contents this conversation has
 * already received at full detail. Keyed by content hash — if the code
 * changed since it was sent, the hash differs and the chunk counts as
 * fresh again automatically.
 */
export class SentChunkStore {
  constructor(private db: Db) {}

  sentHashes(conversationId: string): Set<string> {
    const rows = this.db
      .prepare(
        "SELECT chunk_hash FROM context_sent_chunks WHERE conversation_id = ?"
      )
      .all(conversationId) as Array<{ chunk_hash: string }>;
    return new Set(rows.map((r) => r.chunk_hash));
  }

  markSent(conversationId: string, chunks: RetrievedChunk[]): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO context_sent_chunks(" +
        "conversation_id, chunk_hash, path, tokens, sent_at) " +
        "VALUES (?, ?, ?, ?, ?)"
    );
    const now = Date.now();
    for (const chunk of chunks) {
      if (!chunk.contentHash) continue;
      stmt.run(
        conversationId,
        chunk.contentHash,
        chunk.path,
        chunk.tokenCount ?? 0,
        now
      );
    }
  }
}
