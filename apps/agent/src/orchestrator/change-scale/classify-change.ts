import { isInertFile } from "./inert-file.js";

/**
 * How big a change really is, read from its diff rather than its file list.
 *
 * `touchesCode` is a file-extension test: a one-word label edit in a `.tsx`
 * file is "code" and earns the full tail — validators, a multi-round review,
 * a completion gate demanding test evidence. A copy change got nine test
 * rewrites, eleven test runs and a production build out of that. The diff
 * says what moved; when every changed line differs only inside a string
 * literal or a JSX text node, nothing a compiler, a reviewer or a test can
 * judge has changed, and the tail should know it.
 *
 * - `inert`: only files nothing type-checks (env, docs, images, lockfiles).
 * - `copy`: a handful of lines, each changed only inside quotes / JSX text.
 * - `code`: anything else — the default whenever the diff is unclear.
 */
export type ChangeScale = "inert" | "copy" | "code";

export interface FileDiff {
  path: string;
  /** Unified diff text for that file, as `git diff` prints it. */
  diff: string;
}

/** Above this many changed lines a change is code however small each line. */
const MAX_COPY_LINES = 10;
const MAX_COPY_LINES_PER_FILE = 6;

export function classifyChange(diffs: FileDiff[]): ChangeScale {
  if (diffs.length === 0) return "code";
  const live = diffs.filter((d) => !isInertFile(d.path));
  if (live.length === 0) return "inert";
  let total = 0;
  for (const file of live) {
    const verdict = classifyFileDiff(file.diff);
    if (verdict === null) return "code";
    if (verdict > MAX_COPY_LINES_PER_FILE) return "code";
    total += verdict;
    if (total > MAX_COPY_LINES) return "code";
  }
  return total > 0 ? "copy" : "code";
}

/**
 * Number of changed lines when the whole diff is copy-only, else null.
 * Removed and added lines are paired in order within each hunk; a pair is
 * copy-only when the two lines are identical once every string literal and
 * JSX text node is blanked. An unpaired line qualifies only if it is a
 * key/value string line (`'a.b': 'text',`) or pure JSX text.
 */
export function classifyFileDiff(diff: string): number | null {
  const removed: string[] = [];
  const added: string[] = [];
  let changed = 0;
  const flush = (): boolean => {
    const pairs = Math.min(removed.length, added.length);
    for (let i = 0; i < pairs; i++) {
      if (mask(removed[i]!) !== mask(added[i]!)) return false;
    }
    for (const line of [...removed.slice(pairs), ...added.slice(pairs)]) {
      if (!isCopyLine(line)) return false;
    }
    changed += Math.max(removed.length, added.length);
    removed.length = 0;
    added.length = 0;
    return true;
  };
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("@@") || raw.startsWith("diff ") || raw.startsWith("index ")) {
      if (!flush()) return null;
      continue;
    }
    if (raw.startsWith("-")) removed.push(raw.slice(1));
    else if (raw.startsWith("+")) added.push(raw.slice(1));
    else if (!flush()) return null;
  }
  if (!flush()) return null;
  return changed;
}

/** Blank string-literal contents and JSX text so only structure remains. */
function mask(line: string): string {
  return line
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/>([^<>{}]+)</g, "><")
    .replace(/\s+/g, " ")
    .trim();
}

/** A whole line that is nothing but copy: a string map entry or JSX text. */
function isCopyLine(line: string): boolean {
  const masked = mask(line);
  if (masked === "") return true;
  // `'key': 'value',` / `key: "value",` / `"key": "value"`
  if (/^(?:''|""|[\w.$-]+)\s*:\s*(?:''|""|``)\s*,?$/.test(masked)) return true;
  // `<p>text</p>` style lines collapse to tags only.
  if (/^(?:<[^<>]+>)+$/.test(masked) && />[^<>]+</.test(line)) return true;
  return false;
}
