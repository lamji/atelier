import type { Db } from "../storage/db.js";

/**
 * Top-level symbol kinds the one-per-file rule counts. Exported so the
 * guard measures the rule exactly the way this check decides whether the
 * rule applies at all — two different definitions would let the guard
 * enforce something the workspace was never judged against.
 */
export const COUNTED_KINDS = ["function", "component", "hook", "class"];

/** Below this many parsed files the sample says nothing either way. */
const MIN_SAMPLE = 20;

/**
 * Share of multi-symbol files above which this workspace plainly keeps
 * several functions per file. Deliberately not zero: Atelier's own repo
 * carries legacy offenders, and the guard already tolerates those.
 */
const MAX_MULTI_SHARE = 0.25;

/** The answer moves at the speed of a codebase, so re-read rarely. */
const TTL_MS = 30_000;

let cached: { at: number; follows: boolean } | null = null;

/**
 * Whether THIS workspace actually keeps one top-level
 * function/component/class per file.
 *
 * One file = one function is Atelier's house style, not a universal truth.
 * Enforced unconditionally it turned every other repo into a restructuring
 * job: a file that already holds five functions refuses the sixth, so the
 * agent either splits code nobody asked it to touch — the exact scope creep
 * SYSTEM_RULES forbids two paragraphs earlier — or stalls.
 *
 * The knowledge graph already knows the answer, so it is measured rather
 * than assumed: of the files that hold any top-level symbol, how many hold
 * more than one. A workspace that is mostly multi-symbol has a different
 * convention and gets left alone.
 *
 * Too little evidence stands the rule DOWN rather than up. A blocking guard
 * has to earn its block; refusing writes on an unindexed or tiny workspace
 * is the failure this exists to prevent, and the rule re-arms by itself as
 * soon as the index shows the convention holds.
 */
export function followsOneSymbolPerFile(db: Db): boolean {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.follows;

  const placeholders = COUNTED_KINDS.map(() => "?").join(", ");
  const row = db
    .prepare(
      "SELECT COUNT(*) AS files, " +
        "SUM(CASE WHEN n >= 2 THEN 1 ELSE 0 END) AS multi FROM (" +
        "SELECT file_id, COUNT(*) AS n FROM symbols " +
        `WHERE parent_symbol_id IS NULL AND kind IN (${placeholders}) ` +
        "GROUP BY file_id)"
    )
    .get(...COUNTED_KINDS) as { files?: number; multi?: number } | undefined;

  const files = row?.files ?? 0;
  const multi = row?.multi ?? 0;
  const follows = files >= MIN_SAMPLE && multi / files <= MAX_MULTI_SHARE;
  cached = { at: now, follows };
  return follows;
}
