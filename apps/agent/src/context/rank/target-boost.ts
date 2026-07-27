import type { RetrievedChunk } from "@atelier/protocol";

const DIRECT_BOOST = 0.2;
const NEIGHBOR_BOOST = 0.1;

/**
 * Graph-proximity boost: chunks from the files the task names get the
 * strongest lift; files one import edge away from a target get a smaller
 * one. Retrieval similarity finds "looks alike" — this rewards "is the
 * thing being changed".
 */
export function targetBoost(
  chunk: RetrievedChunk,
  targetPaths: Set<string>,
  neighborPaths: Set<string>
): number {
  if (targetPaths.size === 0) return 0;
  if (targetPaths.has(chunk.path)) return DIRECT_BOOST;
  if (neighborPaths.has(chunk.path)) return NEIGHBOR_BOOST;
  return 0;
}
