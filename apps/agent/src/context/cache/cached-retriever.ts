import { createHash } from "node:crypto";
import type { RetrievalResult } from "@atelier/protocol";
import { LruMap } from "./lru-map.js";
import type { IndexGeneration } from "./index-generation.js";

export interface RetrieveFilters {
  pathGlob?: string;
  kinds?: string[];
}

/** The retrieval surface the pipeline and tools actually depend on. */
export interface RetrieverLike {
  retrieve(
    query: string,
    k?: number,
    filters?: RetrieveFilters
  ): Promise<RetrievalResult>;
}

const MAX_ENTRIES = 100;

/**
 * Drop-in semantic cache over the hybrid retriever: identical queries
 * against an unchanged index return instantly (skipping the query
 * re-embed and all four arms). Keys embed the index generation, so any
 * reindex invalidates every stale entry at once.
 */
export class CachedRetriever implements RetrieverLike {
  private cache = new LruMap<string, RetrievalResult>(MAX_ENTRIES);
  hits = 0;
  misses = 0;

  constructor(
    private inner: RetrieverLike,
    private generation: IndexGeneration
  ) {}

  async retrieve(
    query: string,
    k?: number,
    filters?: RetrieveFilters
  ): Promise<RetrievalResult> {
    const key = this.keyFor(query, k, filters);
    const cached = this.cache.get(key);
    if (cached) {
      this.hits += 1;
      return cached;
    }
    this.misses += 1;
    const result = await this.inner.retrieve(query, k, filters);
    this.cache.set(key, result);
    return result;
  }

  private keyFor(
    query: string,
    k?: number,
    filters?: RetrieveFilters
  ): string {
    const hash = createHash("sha1").update(query).digest("hex");
    return `${hash}|${k ?? 12}|${JSON.stringify(filters ?? null)}` +
      `|${this.generation.current}`;
  }
}
