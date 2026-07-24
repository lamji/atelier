import type { Db } from "../../storage/db.js";
import type { Embedder } from "../embeddings/embedder.js";
import type { VectorStore } from "../embeddings/vector-store.js";

export interface CloneHit {
  /** File that looks like the changed code but was not changed. */
  path: string;
  /** Symbol name when the match is a symbol chunk. */
  symbol?: string;
  startRow?: number;
  endRow?: number;
  /** Cosine similarity to the changed chunk (0..1). */
  score: number;
  /** Changed file whose code it resembles. */
  resembles: string;
}

interface ChunkRow {
  id: number;
  path: string;
  symbol: string | null;
  start_row: number | null;
  end_row: number | null;
  text: string;
}

/**
 * Below this, "similar" is just "same language" — not worth reporting.
 * Calibrated on MiniLM code chunks: a genuine twin (same shape, one line
 * different) lands around 0.77, a test file for the same component around
 * 0.53, unrelated service code around 0.27.
 */
const MIN_SCORE = 0.7;
/** Chunks per changed file used as probes (largest first). */
const PROBES_PER_FILE = 4;
/** Tiny chunks (imports, one-liners) match everything; skip them. */
const MIN_PROBE_CHARS = 200;
const NEIGHBOURS_PER_PROBE = 12;

/**
 * Finds code elsewhere in the workspace that looks like the code a task
 * just changed — parallel implementations that no import edge connects,
 * so the dependency graph can never surface them.
 *
 * This is the "you fixed it here, the same bug lives there" check: after
 * an edit, each changed file's chunks are used as vector probes and any
 * strongly similar chunk in an untouched file is reported back for the
 * model to verify.
 */
export class CloneScanner {
  constructor(
    private db: Db,
    private embedder: Embedder,
    private vectors: VectorStore
  ) {}

  /** Best match per untouched file, strongest first. */
  async siblingsOf(changedPaths: string[], limit = 8): Promise<CloneHit[]> {
    if (changedPaths.length === 0) return [];
    // `available` only becomes true after the model loads — without this
    // the sweep silently no-ops on a fresh process.
    await this.embedder.init();
    if (!this.embedder.available) return [];
    const changed = new Set(changedPaths);
    const best = new Map<string, CloneHit>();

    for (const path of changedPaths) {
      for (const probe of this.probesFor(path)) {
        const vector = await this.vectorFor(probe);
        if (!vector) continue;
        for (const hit of this.vectors.search(vector, NEIGHBOURS_PER_PROBE)) {
          if (hit.score < MIN_SCORE) continue;
          const row = this.chunkById(hit.chunkId);
          if (!row || changed.has(row.path) || row.path === path) continue;
          const current = best.get(row.path);
          if (current && current.score >= hit.score) continue;
          best.set(row.path, {
            path: row.path,
            symbol: row.symbol ?? undefined,
            startRow: row.start_row ?? undefined,
            endRow: row.end_row ?? undefined,
            score: Number(hit.score.toFixed(3)),
            resembles: path,
          });
        }
      }
    }

    return [...best.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Largest code chunks of a file — the meaningful probes. */
  private probesFor(path: string): ChunkRow[] {
    return this.db
      .prepare(
        "SELECT c.id, f.path, s.name AS symbol, c.start_row, c.end_row, " +
          "c.text FROM chunks c JOIN files f ON f.id = c.file_id " +
          "LEFT JOIN symbols s ON s.id = c.symbol_id " +
          "WHERE f.path = ? AND c.kind = 'code' AND length(c.text) >= ? " +
          "ORDER BY length(c.text) DESC LIMIT ?"
      )
      .all(path, MIN_PROBE_CHARS, PROBES_PER_FILE) as ChunkRow[];
  }

  /** Code chunks only: 'doc' chunks are prose summaries, not twins. */
  private chunkById(chunkId: number): ChunkRow | undefined {
    return this.db
      .prepare(
        "SELECT c.id, f.path, s.name AS symbol, c.start_row, c.end_row, " +
          "c.text FROM chunks c JOIN files f ON f.id = c.file_id " +
          "LEFT JOIN symbols s ON s.id = c.symbol_id " +
          "WHERE c.id = ? AND c.kind = 'code'"
      )
      .get(chunkId) as ChunkRow | undefined;
  }

  /** Stored embedding when present, otherwise embed the chunk text. */
  private async vectorFor(chunk: ChunkRow): Promise<Float32Array | null> {
    const row = this.db
      .prepare("SELECT embedding FROM chunk_embeddings WHERE chunk_id = ?")
      .get(chunk.id) as { embedding: Buffer } | undefined;
    if (row) {
      const { buffer, byteOffset, byteLength } = row.embedding;
      return new Float32Array(buffer, byteOffset, byteLength / 4);
    }
    const [vector] = await this.embedder.embed([chunk.text]);
    return vector ?? null;
  }
}
