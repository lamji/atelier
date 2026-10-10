import type { GitCommit } from "@atelier/protocol";

/**
 * Lane layout for the History graph — the GitKraken strip beside the log.
 *
 * Commits arrive newest first (date order, children before parents). Each
 * lane is a column that is "waiting for" one hash. A commit lands in the
 * lane that was waiting for it (or a free one), every other lane waiting
 * for it merges in from above, and its parents then take over lanes below:
 * the first parent keeps the commit's lane, further parents (a merge) join
 * an existing lane or open a new one.
 *
 * Each row carries only what it draws: the node's column and the segments
 * crossing its top half (above → node) and bottom half (node → below).
 */

export interface GraphSegment {
  /** Column at the segment's upper end. */
  from: number;
  /** Column at the segment's lower end. */
  to: number;
  /** Palette index of the lane the line belongs to. */
  color: number;
}

export interface GraphRow {
  col: number;
  color: number;
  /** Segments from the row's top edge down to its centre. */
  top: GraphSegment[];
  /** Segments from the row's centre down to its bottom edge. */
  bottom: GraphSegment[];
  merge: boolean;
}

export interface CommitGraph {
  rows: GraphRow[];
  /** Widest the lanes ever get — the graph column's width. */
  width: number;
}

/**
 * Lane colours. Fixed hues rather than theme tokens: a graph needs more
 * distinct colours than the theme has, and these read on both surfaces.
 */
export const LANE_COLORS = [
  "#3fb6e8",
  "#e0608a",
  "#8bc34a",
  "#f0a030",
  "#a77bf3",
  "#26c6a0",
  "#f06050",
  "#5c8df6",
];

export function laneColor(index: number): string {
  return LANE_COLORS[index % LANE_COLORS.length]!;
}

interface Lane {
  hash: string;
  color: number;
}

export function layoutGraph(commits: GitCommit[]): CommitGraph {
  const lanes: (Lane | null)[] = [];
  const rows: GraphRow[] = [];
  let nextColor = 0;
  let width = 1;

  const freeSlot = (): number => {
    const idx = lanes.indexOf(null);
    return idx >= 0 ? idx : lanes.length;
  };

  for (const commit of commits) {
    const parents = commit.parents ?? [];
    const waiting = lanes
      .map((lane, i) => (lane?.hash === commit.hash ? i : -1))
      .filter((i) => i >= 0);

    // A branch tip nothing above points at opens a lane of its own.
    const col = waiting[0] ?? freeSlot();
    const color = waiting.length > 0 ? lanes[col]!.color : nextColor++;

    const top: GraphSegment[] = [];
    lanes.forEach((lane, i) => {
      if (!lane) return;
      if (lane.hash === commit.hash) {
        top.push({ from: i, to: col, color: lane.color });
      } else {
        top.push({ from: i, to: i, color: lane.color });
      }
    });

    // Lanes that converged on this commit are finished.
    for (const i of waiting) lanes[i] = null;

    const bottom: GraphSegment[] = [];
    if (parents[0]) {
      const existing = lanes.findIndex((l) => l?.hash === parents[0]);
      if (existing >= 0 && existing !== col) {
        // The first parent is already someone else's lane: bend into it.
        bottom.push({ from: col, to: existing, color });
      } else {
        lanes[col] = { hash: parents[0], color };
      }
    }
    for (const parent of parents.slice(1)) {
      const existing = lanes.findIndex((l) => l?.hash === parent);
      if (existing >= 0) {
        bottom.push({ from: col, to: existing, color: lanes[existing]!.color });
        continue;
      }
      const slot = freeSlot();
      const lane = { hash: parent, color: nextColor++ };
      lanes[slot] = lane;
      bottom.push({ from: col, to: slot, color: lane.color });
    }

    // Straight continuations below the node, including the node's own.
    lanes.forEach((lane, i) => {
      if (!lane) return;
      const bent = bottom.some((s) => s.to === i && s.from === col);
      if (bent && i !== col) return;
      bottom.push({ from: i, to: i, color: lane.color });
    });

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    width = Math.max(width, col + 1, lanes.length);
    rows.push({ col, color, top, bottom, merge: parents.length > 1 });
  }

  return { rows, width };
}
