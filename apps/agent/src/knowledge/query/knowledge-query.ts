import type { CodeSymbol, IndexStats } from "@atelier/protocol";
import { NotImplementedError } from "../../not-implemented.js";
import type { Db } from "../../storage/db.js";

/**
 * Phase 5: answers engineering questions from the knowledge DB (symbols,
 * edges, features) before any RAG fallback.
 */
export class KnowledgeQuery {
  constructor(private db: Db) {}

  stats(): IndexStats {
    const count = (sql: string): number =>
      (this.db.prepare(sql).get() as { n: number }).n;
    return {
      files: count("SELECT COUNT(*) n FROM files"),
      symbols: count("SELECT COUNT(*) n FROM symbols"),
      edges: count("SELECT COUNT(*) n FROM call_edges"),
      chunks: count("SELECT COUNT(*) n FROM chunks"),
      embedded: count("SELECT COUNT(*) n FROM chunk_embeddings"),
      features: count("SELECT COUNT(*) n FROM features"),
      lastIndexedAt: null,
    };
  }

  symbol(_id: number): CodeSymbol {
    throw new NotImplementedError("knowledge.symbol");
  }
}
