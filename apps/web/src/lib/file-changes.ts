/** Turns the stream of agent edits into one reviewable change per file. */

import { countChanges } from "./unified-diff";

/** One agent edit, as it arrives from the store (live copy or transcript). */
export interface DiffSource {
  id: string;
  path: string;
  before: string;
  after: string;
}

/** One file's cumulative change across every edit the agent made to it. */
export interface FileChange {
  path: string;
  /** Content before the FIRST edit, so the tab shows the whole change. */
  before: string;
  /** Content after the LAST edit. */
  after: string;
  added: number;
  removed: number;
  /**
   * Other sessions that have also changed this file, by name. Only the
   * working-tree source can know this — an agent run owns its own edits —
   * so it is absent for the transcript-fed rail.
   */
  sharedWith?: string[];
}

/**
 * Collapses a run of edits into one change per file, in first-touched order.
 *
 * The agent commonly rewrites the same file two or three times in a turn. A
 * tab per edit would list "bridge.ts" three times and leave the reader to
 * assemble the file's actual change in their head, so a tab carries the
 * cumulative change instead: the first `before` against the last `after`.
 *
 * `sources` may repeat an id — a live diff and its transcript copy are the
 * same edit — so ids are deduped before grouping.
 */
export function collapseFileChanges(sources: DiffSource[]): FileChange[] {
  const seen = new Set<string>();
  const byPath = new Map<string, { before: string; after: string }>();

  for (const source of sources) {
    if (seen.has(source.id)) continue;
    seen.add(source.id);
    const existing = byPath.get(source.path);
    if (existing) existing.after = source.after;
    else byPath.set(source.path, { before: source.before, after: source.after });
  }

  return [...byPath].map(([path, { before, after }]) => ({
    path,
    before,
    after,
    ...countChanges(before, after),
  }));
}

/** Totals for the tab strip's summary. */
export function totalStat(changes: FileChange[]): {
  added: number;
  removed: number;
} {
  return changes.reduce(
    (total, change) => ({
      added: total.added + change.added,
      removed: total.removed + change.removed,
    }),
    { added: 0, removed: 0 }
  );
}

/** Tab label. A full path never fits a tab in a side rail. */
export function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}
