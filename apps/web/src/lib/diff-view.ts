/** Shared helpers for rendering a before/after diff with Monaco. */

const DIFF_LANGS: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  css: "css",
  html: "html",
  md: "markdown",
  py: "python",
};

export function languageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return DIFF_LANGS[ext] ?? "plaintext";
}

/**
 * Cheap multiset line delta — a fallback for huge diffs where a real diff
 * would be too slow. Not position-aware, so counts can be off for files
 * with many duplicate lines.
 */
function multisetLineStat(
  before: string[],
  after: string[]
): { added: number; removed: number } {
  const counts = new Map<string, number>();
  for (const line of before) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  let added = 0;
  for (const line of after) {
    const n = counts.get(line) ?? 0;
    if (n > 0) counts.set(line, n - 1);
    else added += 1;
  }
  const removed = [...counts.values()].reduce((a, b) => a + b, 0);
  return { added, removed };
}

/** Above this edit distance, Myers diff's O(ND) cost isn't worth it. */
const MAX_MYERS_D = 4000;

/**
 * Real line-level diff (Myers' O(ND) algorithm) so the +added/-removed badge
 * matches what the DiffEditor actually renders below it. Falls back to a
 * cheap multiset estimate only for pathologically large rewrites.
 */
function myersLineStat(
  a: string[],
  b: string[]
): { added: number; removed: number } | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_MYERS_D);
  if (n + m === 0) return { added: 0, removed: 0 };
  const offset = max;
  const trace: number[][] = [];
  let v = new Array(2 * max + 1).fill(0);

  let reachedEnd = false;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
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
  if (!reachedEnd) return null; // edit distance exceeded MAX_MYERS_D

  let x = n;
  let y = m;
  let added = 0;
  let removed = 0;
  for (let d = trace.length - 1; d > 0; d--) {
    const vPrev = trace[d - 1]!;
    const k = x - y;
    const prevK =
      k === -d || (k !== d && vPrev[offset + k - 1]! < vPrev[offset + k + 1]!)
        ? k + 1
        : k - 1;
    const prevX = vPrev[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    if (x === prevX) {
      added++;
      y--;
    } else {
      removed++;
      x--;
    }
  }
  return { added, removed };
}

/** Line delta for a diff header badge, matching the real rendered diff. */
export function lineStat(
  before: string,
  after: string
): { added: number; removed: number } {
  const a = before.split("\n");
  const b = after.split("\n");
  return myersLineStat(a, b) ?? multisetLineStat(a, b);
}

export function diffHeight(before: string, after: string): number {
  const lines = Math.max(before.split("\n").length, after.split("\n").length);
  return Math.min(Math.max(lines * 19 + 24, 90), 320);
}

/** Shared read-only, inline, chrome-light options for an inline diff view. */
export const INLINE_DIFF_EDITOR_OPTIONS = {
  readOnly: true,
  // The card's container resizes after mount (fade-in animation, sibling
  // feed rows pushing layout) — without this Monaco keeps its first-paint
  // measurements and the original/modified line-number gutters can overlap.
  automaticLayout: true,
  renderSideBySide: false,
  renderOverviewRuler: false,
  minimap: { enabled: false },
  fontSize: 12.5,
  // Inline diff mode packs BOTH the original and modified line numbers into
  // one gutter column. 3 chars only fits one 3-digit number — past line 999
  // the two numbers run together (e.g. "2968" + "2968" -> "29682968").
  // 6 fits two 3-digit numbers comfortably and still grows for bigger files.
  lineNumbers: "off" as const,
  lineNumbersMinChars: 0,
  lineDecorationsWidth: 0,
  glyphMargin: false,
  folding: false,
  scrollBeyondLastLine: false,
  hideUnchangedRegions: { enabled: true },
  guides: { indentation: false },
  // Wrap long lines instead of clipping them: the diff card's width now
  // changes as the process rail is resized, so wrapping keeps every line
  // fully visible instead of needing horizontal scroll inside a fixed box.
  wordWrap: "on" as const,
  wrappingIndent: "same" as const,
  scrollbar: {
    vertical: "auto" as const,
    horizontal: "hidden" as const,
    alwaysConsumeMouseWheel: false,
  },
} as const;
