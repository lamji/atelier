import type { RetrievedChunk } from "@atelier/protocol";
import type { Db } from "../../storage/db.js";
import type { SymbolGraph } from "../../knowledge/graph/symbol-graph.js";
import type { RankedItem } from "../types.js";
import { targetBoost } from "./target-boost.js";
import { recencyBoost } from "./recency-boost.js";
import { dedupeAndDiversify } from "./dedupe-and-diversify.js";

export interface RankInput {
  chunks: RetrievedChunk[];
  /** File-shaped intent targets (may be empty). */
  targets: string[];
  graph: SymbolGraph;
  db: Db;
  /** How many ranked chunks to keep. */
  k: number;
  now?: number;
}

/** Lessons are confirmed knowledge — they outrank similarity noise. */
const LESSON_BOOST = 0.15;
const SESSION_MEMORY_BOOST = 0.12;

/**
 * Re-ranks over-fetched retrieval candidates with signals retrieval
 * cannot see: graph proximity to the task's target files, filesystem
 * recency, and lesson priority — then dedupes and enforces per-file
 * diversity. Retrieval finds possible context; this decides what
 * deserves the window.
 */
export function rankCandidates(input: RankInput): RetrievedChunk[] {
  const targetPaths = new Set(
    input.targets.filter((t) => t.includes("/") || t.includes("."))
  );
  const neighborPaths = neighborsOf(input, targetPaths);
  const mtimes = fileMtimes(input.db);
  const now = input.now ?? Date.now();

  const ranked: RankedItem[] = input.chunks.map((chunk) => ({
    chunk,
    rank:
      chunk.score +
      targetBoost(chunk, targetPaths, neighborPaths) +
      recencyBoost(chunk.path, mtimes, now) +
      (chunk.kind === "lesson" ? LESSON_BOOST : 0) +
      (chunk.kind === "session-memory" ? SESSION_MEMORY_BOOST : 0),
  }));
  ranked.sort((a, b) => b.rank - a.rank);

  return dedupeAndDiversify(ranked)
    .slice(0, input.k)
    .map((item) => ({
      ...item.chunk,
      score: Number(item.rank.toFixed(4)),
    }));
}

/** Files one reverse-import edge from any target (its likely callers). */
function neighborsOf(input: RankInput, targets: Set<string>): Set<string> {
  if (targets.size === 0) return new Set();
  try {
    return new Set(input.graph.dependentsOf([...targets]).files);
  } catch {
    return new Set();
  }
}

/** mtime per indexed file path, one query for the whole candidate set. */
function fileMtimes(db: Db): Map<string, number> {
  const rows = db
    .prepare("SELECT path, mtime FROM files WHERE mtime IS NOT NULL")
    .all() as Array<{ path: string; mtime: number }>;
  return new Map(rows.map((r) => [r.path, r.mtime]));
}
