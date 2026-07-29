import type { RankedItem } from "../types.js";
import { MAX_PER_PATH, MAX_SESSION_MEMORY } from "../types.js";

/**
 * Drops exact duplicates (same content hash, or same path+row span) and
 * caps how many chunks any single file contributes, so one hot file
 * cannot crowd every other module out of the window. Input must already
 * be sorted by rank descending.
 */
export function dedupeAndDiversify(items: RankedItem[]): RankedItem[] {
  const seenHashes = new Set<string>();
  const perPath = new Map<string, number>();
  let sessionMemory = 0;
  const out: RankedItem[] = [];
  for (const item of items) {
    const c = item.chunk;
    const key = c.contentHash ?? `${c.path}:${c.startRow ?? 0}-${c.endRow ?? 0}`;
    if (seenHashes.has(key)) continue;
    // One task now writes an overview chunk plus one per unit of work, so a
    // single busy task could otherwise take most of the window. Session
    // memory earns a few slots, never the whole budget.
    if (c.kind === "session-memory") {
      if (sessionMemory >= MAX_SESSION_MEMORY) continue;
      sessionMemory += 1;
    }
    const count = perPath.get(c.path) ?? 0;
    // Lessons and feature summaries share a pseudo-path per kind; the
    // per-file cap is for real source files only.
    const fileless =
      c.kind === "lesson" ||
      c.kind === "feature-summary" ||
      c.kind === "session-memory";
    if (!fileless && count >= MAX_PER_PATH) continue;
    seenHashes.add(key);
    perPath.set(c.path, count + 1);
    out.push(item);
  }
  return out;
}
