/**
 * Line-level unified diff — the rows a reviewer reads, not an editor widget.
 *
 * Monaco's inline diff packs BOTH sides' line numbers into one gutter, which
 * leaves a dead column the width of two numbers in a narrow rail and offers
 * no way to show a single number per row. A unified diff is a list of rows;
 * this builds that list so the view can render it as one.
 */

/** Above this edit distance, Myers' O(ND) cost isn't worth it. */
const MAX_MYERS_D = 4000;

/** A rail is not a code review tool; past this the file is a scroll, not a read. */
const MAX_ROWS = 1500;

/** Unchanged lines kept either side of a change, so a hunk has a setting. */
const CONTEXT = 3;

interface DiffOp {
  kind: "eq" | "add" | "del";
  text: string;
  /** 1-based line in the BEFORE text (meaningful for eq and del). */
  aLine: number;
  /** 1-based line in the AFTER text (meaningful for eq and add). */
  bLine: number;
}

export type DiffRow =
  | { kind: "eq" | "add" | "del"; num: number; text: string }
  /** A collapsed run of unchanged lines. */
  | { kind: "gap"; hidden: number };

export interface UnifiedDiff {
  rows: DiffRow[];
  /** Rows dropped at MAX_ROWS. Never silent — the view says so. */
  truncated: number;
}

/**
 * Myers' O(ND) edit script.
 *
 * `trace[d]` is V as it stood BEFORE round d — which is V after round d-1,
 * and so exactly what the backtrack needs to ask "where did round d come
 * from?". Reading `trace[d - 1]` there instead is an off-by-one that still
 * produces plausible add/remove COUNTS, which is how it survives unnoticed
 * in a stat-only implementation, but yields a nonsense script.
 *
 * Returns null when the edit distance exceeds MAX_MYERS_D.
 */
function diffOps(a: string[], b: string[]): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_MYERS_D);
  const offset = max;
  const trace: number[][] = [];
  const v: number[] = new Array(2 * max + 1).fill(0);

  let reachedEnd = false;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        reachedEnd = true;
        break outer;
      }
    }
  }
  if (!reachedEnd) return null;

  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK =
      k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)
        ? k + 1
        : k - 1;
    const prevX = vd[offset + prevK]!;
    const prevY = prevX - prevK;
    // The diagonal run that ends this round: lines both sides share.
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: "eq", text: a[x]!, aLine: x + 1, bLine: y + 1 });
    }
    // Round 0 is the leading diagonal; there is no edit in front of it.
    if (d === 0) break;
    if (x === prevX) {
      y--;
      ops.push({ kind: "add", text: b[y]!, aLine: x, bLine: y + 1 });
    } else {
      x--;
      ops.push({ kind: "del", text: a[x]!, aLine: x + 1, bLine: y });
    }
  }
  return ops.reverse();
}

/**
 * Cheap multiset line delta — the fallback for rewrites too large for Myers.
 * Not position-aware, so counts can be off for files with many duplicate
 * lines, which is the right trade at the size that gets here.
 */
function multisetStat(
  before: string[],
  after: string[]
): { added: number; removed: number } {
  const counts = new Map<string, number>();
  for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of after) {
    const n = counts.get(line) ?? 0;
    if (n > 0) counts.set(line, n - 1);
    else added += 1;
  }
  const removed = [...counts.values()].reduce((a, b) => a + b, 0);
  return { added, removed };
}

/** Line delta for a tab's badge, from the same script the rows are built from. */
export function countChanges(
  before: string,
  after: string
): { added: number; removed: number } {
  const a = before.split("\n");
  const b = after.split("\n");
  const ops = diffOps(a, b);
  if (ops === null) return multisetStat(a, b);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "add") added++;
    else if (op.kind === "del") removed++;
  }
  return { added, removed };
}

/** Every unchanged line close enough to a change to be worth keeping. */
function keptContext(ops: DiffOp[]): boolean[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.kind === "eq") continue;
    const from = Math.max(0, i - CONTEXT);
    const to = Math.min(ops.length - 1, i + CONTEXT);
    for (let j = from; j <= to; j++) keep[j] = true;
  }
  return keep;
}

/** Whole-file replacement, for when the edit distance blew past the cap. */
function rewriteRows(a: string[], b: string[]): DiffRow[] {
  return [
    ...a.map((text, i): DiffRow => ({ kind: "del", num: i + 1, text })),
    ...b.map((text, i): DiffRow => ({ kind: "add", num: i + 1, text })),
  ];
}

/**
 * The rows for one file's change: every changed line, three lines of context
 * either side, and a single "gap" row standing in for each run of untouched
 * lines between hunks.
 */
export function buildUnifiedDiff(before: string, after: string): UnifiedDiff {
  const a = before.split("\n");
  const b = after.split("\n");
  const ops = diffOps(a, b);

  const rows: DiffRow[] = [];
  if (ops === null) {
    rows.push(...rewriteRows(a, b));
  } else {
    const keep = keptContext(ops);
    let hidden = 0;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      if (!keep[i]) {
        hidden++;
        continue;
      }
      if (hidden > 0) {
        rows.push({ kind: "gap", hidden });
        hidden = 0;
      }
      rows.push({
        kind: op.kind,
        num: op.kind === "del" ? op.aLine : op.bLine,
        text: op.text,
      });
    }
    if (hidden > 0) rows.push({ kind: "gap", hidden });
  }

  if (rows.length <= MAX_ROWS) return { rows, truncated: 0 };
  return { rows: rows.slice(0, MAX_ROWS), truncated: rows.length - MAX_ROWS };
}
