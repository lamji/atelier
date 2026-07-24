/**
 * VectorStore smoke: proves the sqlite-vec backend loads, upserts, and
 * searches (falls back to JS cosine if the extension is unavailable).
 *
 *   pnpm --filter @atelier/agent smoke:vec
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/storage/db.js";
import { VectorStore } from "../src/knowledge/embeddings/vector-store.js";

function unit(values: number[]): Float32Array {
  const v = Float32Array.from(values);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm) as Float32Array;
}

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-vsmoke-"));
  const db = openDb(dataDir);
  const store = new VectorStore(db, 4);
  console.log(`backend: ${store.backend}`);

  // Chunk rows must exist for the FK + rebuild path.
  const insertChunk = db.prepare(
    "INSERT INTO chunks(kind, content_hash, text) VALUES ('code', ?, ?)"
  );
  const vectors: Record<number, Float32Array> = {
    [Number(insertChunk.run("h1", "north").lastInsertRowid)]: unit([1, 0, 0, 0]),
    [Number(insertChunk.run("h2", "east").lastInsertRowid)]: unit([0, 1, 0, 0]),
    [Number(insertChunk.run("h3", "up").lastInsertRowid)]: unit([0, 0, 1, 0]),
    [Number(insertChunk.run("h4", "northish").lastInsertRowid)]: unit([0.9, 0.1, 0, 0]),
  };
  for (const [id, vec] of Object.entries(vectors)) store.upsert(Number(id), vec);

  const northIds = Object.keys(vectors).map(Number);
  const hits = store.search(unit([1, 0, 0, 0]), 2);
  console.log("top-2 for 'north':", JSON.stringify(hits));

  let fail = 0;
  const check = (name: string, ok: boolean) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) fail++;
  };
  check("returns 2 hits", hits.length === 2);
  check("best match is the north vector", hits[0]?.chunkId === northIds[0]);
  check(
    "second match is the north-ish vector",
    hits[1]?.chunkId === northIds[3]
  );
  check("scores are descending", (hits[0]?.score ?? 0) >= (hits[1]?.score ?? 1));

  // forget removes from search.
  store.forget([northIds[0]!]);
  const after = store.search(unit([1, 0, 0, 0]), 1);
  check("forget drops the vector", after[0]?.chunkId !== northIds[0]);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(fail === 0 ? "\nall vec cases pass" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
