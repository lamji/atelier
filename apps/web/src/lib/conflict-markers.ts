/**
 * Conflict-marker parsing and editing for the merge resolver. Pure text
 * functions over the buffer Monaco holds, so the resolver can act on the
 * exact bytes the user sees — including partial edits — rather than on a
 * stale snapshot from the agent.
 *
 * Handles both marker styles git writes:
 *
 *   <<<<<<< ours          <<<<<<< ours
 *   current               current
 *   =======               ||||||| base        (merge.conflictStyle=diff3)
 *   incoming              base
 *   >>>>>>> theirs        =======
 *                         incoming
 *                         >>>>>>> theirs
 */

export interface ConflictBlock {
  /** 1-based line of the `<<<<<<<` marker. */
  start: number;
  /** 1-based line of the `|||||||` marker (diff3 only). */
  baseSep: number | null;
  /** 1-based line of the `=======` marker. */
  sep: number;
  /** 1-based line of the `>>>>>>>` marker. */
  end: number;
  oursLabel: string;
  theirsLabel: string;
}

export type ConflictChoice = "ours" | "theirs" | "both" | "base";

const OURS_RE = /^<{7}(?: (.*))?$/;
const BASE_RE = /^\|{7}(?: (.*))?$/;
const SEP_RE = /^={7}$/;
const THEIRS_RE = /^>{7}(?: (.*))?$/;

/** Every well-formed conflict block in `text`, in document order. */
export function parseConflicts(text: string): ConflictBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: ConflictBlock[] = [];
  let open: { start: number; oursLabel: string; baseSep: number | null; sep: number | null } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const n = i + 1;
    const ours = line.match(OURS_RE);
    if (ours) {
      open = { start: n, oursLabel: ours[1] ?? "", baseSep: null, sep: null };
      continue;
    }
    if (!open) continue;
    if (open.sep === null && BASE_RE.test(line)) {
      open.baseSep = n;
      continue;
    }
    if (open.sep === null && SEP_RE.test(line)) {
      open.sep = n;
      continue;
    }
    const theirs = line.match(THEIRS_RE);
    if (theirs && open.sep !== null) {
      blocks.push({
        start: open.start,
        baseSep: open.baseSep,
        sep: open.sep,
        end: n,
        oursLabel: open.oursLabel,
        theirsLabel: theirs[1] ?? "",
      });
      open = null;
    }
  }
  return blocks;
}

/** True when any marker line is still present. */
export function hasConflictMarkers(text: string): boolean {
  return parseConflicts(text).length > 0;
}

/**
 * Rewrites ONE block to the chosen side and returns the new text. Line
 * numbers of later blocks shift, so callers re-parse after each edit.
 * The file's own line ending is preserved.
 */
export function resolveBlock(
  text: string,
  block: ConflictBlock,
  choice: ConflictChoice
): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const oursLines = lines.slice(block.start, (block.baseSep ?? block.sep) - 1);
  const baseLines = block.baseSep
    ? lines.slice(block.baseSep, block.sep - 1)
    : [];
  const theirsLines = lines.slice(block.sep, block.end - 1);

  const replacement =
    choice === "ours"
      ? oursLines
      : choice === "theirs"
        ? theirsLines
        : choice === "base"
          ? baseLines
          : [...oursLines, ...theirsLines];

  const before = lines.slice(0, block.start - 1);
  const after = lines.slice(block.end);
  return [...before, ...replacement, ...after].join(eol);
}

/** Applies `choice` to every block, first to last. */
export function resolveAll(text: string, choice: ConflictChoice): string {
  let current = text;
  // Re-parse each round: resolving a block moves everything under it.
  for (let guard = 0; guard < 10_000; guard++) {
    const [first] = parseConflicts(current);
    if (!first) break;
    current = resolveBlock(current, first, choice);
  }
  return current;
}

/** Index of the block containing `line`, or the next one after it. */
export function blockAtOrAfter(blocks: ConflictBlock[], line: number): number {
  const idx = blocks.findIndex((b) => b.end >= line);
  return idx === -1 ? (blocks.length > 0 ? 0 : -1) : idx;
}
