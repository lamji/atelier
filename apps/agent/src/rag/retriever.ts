import type { RetrievalResult } from "@atelier/protocol";
import type { Db } from "../storage/db.js";

/**
 * Phase 5: hybrid retrieval — vector top-k + graph neighborhood of
 * mentioned symbols + feature summaries, merged and ranked.
 */
export class Retriever {
  constructor(private db: Db) {}

  async retrieve(
    _query: string,
    _k = 12,
    _filters?: { pathGlob?: string; kinds?: string[] }
  ): Promise<RetrievalResult> {
    return { strategy: "empty(not-indexed)", chunks: [], graphNodes: [], features: [] };
  }
}
