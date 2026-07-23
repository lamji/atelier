import type { Db } from "../../storage/db.js";

export interface VectorHit {
  chunkId: number;
  score: number;
}

/**
 * Vector search over chunk embeddings. Embeddings always persist as BLOBs
 * in chunk_embeddings; when the sqlite-vec extension loads, a vec_chunks
 * virtual table mirrors them for fast ANN search. Otherwise search falls
 * back to an in-memory JS cosine scan (fine for tens of thousands of
 * chunks at 384 dims).
 */
export class VectorStore {
  private vecAvailable = false;
  /** JS-fallback cache: chunkId -> normalized embedding. */
  private cache = new Map<number, Float32Array>();
  private cacheLoaded = false;

  constructor(
    private db: Db,
    private dims: number
  ) {
    this.vecAvailable = this.tryLoadSqliteVec();
  }

  get backend(): "sqlite-vec" | "js-cosine" {
    return this.vecAvailable ? "sqlite-vec" : "js-cosine";
  }

  private tryLoadSqliteVec(): boolean {
    try {
      // Dynamic require keeps startup working when the native ext is broken.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const requireFn = eval("require") as NodeJS.Require;
      const sqliteVec = requireFn("sqlite-vec") as {
        load: (db: unknown) => void;
      };
      sqliteVec.load(this.db);
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
          chunk_id INTEGER PRIMARY KEY,
          embedding float[${this.dims}]
        )`
      );
      // Rebuild the mirror if it drifted from the source of truth.
      const blobCount = this.count("SELECT COUNT(*) n FROM chunk_embeddings");
      const vecCount = this.count("SELECT COUNT(*) n FROM vec_chunks");
      if (vecCount !== blobCount) this.rebuildVecTable();
      return true;
    } catch {
      return false;
    }
  }

  private count(sql: string): number {
    return (this.db.prepare(sql).get() as { n: number }).n;
  }

  private rebuildVecTable(): void {
    const rows = this.db
      .prepare("SELECT chunk_id, embedding FROM chunk_embeddings")
      .all() as Array<{ chunk_id: number; embedding: Buffer }>;
    const del = this.db.prepare("DELETE FROM vec_chunks");
    const ins = this.db.prepare(
      "INSERT INTO vec_chunks(chunk_id, embedding) VALUES (?, ?)"
    );
    this.db.transaction(() => {
      del.run();
      for (const row of rows) ins.run(row.chunk_id, row.embedding);
    })();
  }

  upsert(chunkId: number, embedding: Float32Array): void {
    const blob = Buffer.from(
      embedding.buffer,
      embedding.byteOffset,
      embedding.byteLength
    );
    this.db
      .prepare(
        "INSERT INTO chunk_embeddings(chunk_id, embedding, dims) VALUES (?, ?, ?) " +
          "ON CONFLICT(chunk_id) DO UPDATE SET embedding = excluded.embedding, " +
          "dims = excluded.dims"
      )
      .run(chunkId, blob, this.dims);
    if (this.vecAvailable) {
      this.db.prepare("DELETE FROM vec_chunks WHERE chunk_id = ?").run(chunkId);
      this.db
        .prepare("INSERT INTO vec_chunks(chunk_id, embedding) VALUES (?, ?)")
        .run(chunkId, blob);
    }
    if (this.cacheLoaded) {
      this.cache.set(chunkId, Float32Array.from(embedding));
    }
  }

  /** Called after chunk rows are deleted; embeddings cascade in SQL. */
  forget(chunkIds: number[]): void {
    if (chunkIds.length === 0) return;
    if (this.vecAvailable) {
      const del = this.db.prepare("DELETE FROM vec_chunks WHERE chunk_id = ?");
      this.db.transaction(() => {
        for (const id of chunkIds) del.run(id);
      })();
    }
    for (const id of chunkIds) this.cache.delete(id);
  }

  search(embedding: Float32Array, k: number): VectorHit[] {
    if (this.vecAvailable) return this.searchVec(embedding, k);
    return this.searchJs(embedding, k);
  }

  private searchVec(embedding: Float32Array, k: number): VectorHit[] {
    const blob = Buffer.from(
      embedding.buffer,
      embedding.byteOffset,
      embedding.byteLength
    );
    const rows = this.db
      .prepare(
        "SELECT chunk_id, distance FROM vec_chunks " +
          "WHERE embedding MATCH ? AND k = ? ORDER BY distance"
      )
      .all(blob, k) as Array<{ chunk_id: number; distance: number }>;
    // vec0 distance is L2 on normalized vectors: cos = 1 - d^2 / 2.
    return rows.map((r) => ({
      chunkId: r.chunk_id,
      score: 1 - (r.distance * r.distance) / 2,
    }));
  }

  private searchJs(embedding: Float32Array, k: number): VectorHit[] {
    this.ensureCache();
    const hits: VectorHit[] = [];
    for (const [chunkId, vec] of this.cache) {
      let dot = 0;
      for (let i = 0; i < vec.length; i++) dot += vec[i]! * embedding[i]!;
      hits.push({ chunkId, score: dot });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  private ensureCache(): void {
    if (this.cacheLoaded) return;
    const rows = this.db
      .prepare("SELECT chunk_id, embedding FROM chunk_embeddings")
      .all() as Array<{ chunk_id: number; embedding: Buffer }>;
    for (const row of rows) {
      this.cache.set(
        row.chunk_id,
        new Float32Array(
          row.embedding.buffer,
          row.embedding.byteOffset,
          row.embedding.byteLength / 4
        )
      );
    }
    this.cacheLoaded = true;
  }
}
