import { resolveEdit } from "../../workspace/file-service.js";

/**
 * Ollama-only edit repair. The shared tools (replace_code / replace_many)
 * match `oldString` byte-for-byte, with one fallback for the file's line
 * endings. That is the right contract for a frontier model, which copies
 * the text it read; a local model does not. It re-types the block from
 * memory, drops trailing spaces, or re-indents to its own taste, and the
 * tool answers "oldString not found" — a message that says nothing about
 * what IS in the file. The model re-reads, guesses again, and burns the
 * turn budget on the same miss.
 *
 * So the drift is absorbed HERE, on the way into the tool, and never in
 * the tool: the Claude and Codex paths keep the strict matcher. Two rules
 * keep the leniency safe — a repaired edit must resolve to exactly one
 * place in the file, and the text finally handed to the tool is the file's
 * own bytes, so the write itself is still an exact replacement.
 */

/** The slice of FileService this module needs (reads stay path-guarded). */
export interface EditFileReader {
  readFile(
    relPath: string,
    opts?: { offset?: number; limit?: number }
  ): Promise<{ content: string; totalLines?: number }>;
}

export interface EditInput {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export type PreparedEdit =
  /** Hand this (possibly rewritten) input to the shared tool. */
  | { status: "ready"; input: EditInput; repairedBy?: Tier }
  /** The workspace already says what the edit asks for — do not call it. */
  | { status: "noop"; message: string };

/** How an edit was matched, loosest tier last. */
export type Tier = "exact" | "eol" | "trailing-space" | "indent";

/** Lines of file text quoted back to the model on a miss. */
const MAX_EXCERPT_LINES = 14;
const MAX_EXCERPT_COLS = 200;

/** Above this the window scan is not worth the wall clock. */
const MAX_SCAN_LINES = 20_000;

/** Shortest replacement that can prove, by its presence, that it landed. */
const MIN_APPLIED_EVIDENCE = 16;

export function isEditTool(name: string): boolean {
  return name === "replace_code" || name === "replace_many";
}

/** Reads `replace_code` / `replace_many` arguments into a common shape. */
export function editsOf(name: string, input: unknown): EditInput[] {
  const raw = input as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") return [];
  if (name === "replace_code") {
    return isEdit(raw) ? [raw] : [];
  }
  const edits = Array.isArray(raw.edits) ? raw.edits : [];
  return edits.filter(isEdit);
}

function isEdit(value: unknown): value is EditInput {
  const edit = value as EditInput | null;
  return (
    !!edit &&
    typeof edit.path === "string" &&
    typeof edit.oldString === "string" &&
    typeof edit.newString === "string"
  );
}

/**
 * Rewrites one edit against the bytes on disk. A unique whitespace-tolerant
 * match is converted into the exact text the file holds — including the
 * replacement, re-indented to the place it lands in. Anything ambiguous is
 * passed through untouched so the tool fails and the model is told why.
 */
export async function prepareEdit(
  files: EditFileReader,
  input: EditInput
): Promise<PreparedEdit> {
  const content = await readOrNull(files, input.path);
  // No file, no repair. The tool owns that error and reports it well.
  if (content === null) return { status: "ready", input };

  const match = matchEdit(content, input.oldString, input.newString);
  if (match && match.count === 1) {
    if (match.tier === "exact") return { status: "ready", input };
    return {
      status: "ready",
      repairedBy: match.tier,
      input: {
        ...input,
        oldString: match.oldString,
        newString: match.newString,
      },
    };
  }
  // Several matches are never repaired, replaceAll or not. A lenient tier
  // reports the bytes of the FIRST place it hit, and the others matched
  // only because their whitespace was normalized away — so replacing "all"
  // of that exact text would quietly skip them. An exact or line-ending
  // match needs no repair here anyway: the tool resolves it identically.
  // The edit already landed — an earlier call in this turn, or an earlier
  // turn. Left alone this is the loop that never ends: the model "fixes" a
  // file that is already correct, is told the old text is missing, re-reads,
  // and tries again. Say so plainly and let it move on.
  if (!match && isAlreadyApplied(content, input)) {
    return {
      status: "noop",
      message:
        `Already applied — ${input.path} already contains newString and no ` +
        "longer contains oldString. Nothing was changed and nothing needs " +
        "to be: treat this edit as done and continue with the next step.",
    };
  }
  return { status: "ready", input };
}

/**
 * Replaces a bare "oldString not found" with something the model can act
 * on: whether the change is already in the file, whether the text it sent
 * is ambiguous, and — the part that actually ends the retry loop — the
 * file's own nearest lines, quoted, to copy from.
 */
export async function explainEditFailure(
  files: EditFileReader,
  input: EditInput,
  error: unknown
): Promise<string> {
  const original = `Error: ${String(error)}`;
  // Only the miss is rewritten. A hook block, a bad path or the tool's own
  // "occurs N times" message are already specific.
  if (!/oldString not found/i.test(original)) return original;

  const content = await readOrNull(files, input.path);
  if (content === null) return original;

  if (isAlreadyApplied(content, input)) {
    return (
      `Already applied — ${input.path} already contains newString. This ` +
      "edit is done; do not send it again."
    );
  }

  const match = matchEdit(content, input.oldString, input.newString);
  if (match && match.count > 1) {
    // Deliberately not "pass replaceAll": these matched only after their
    // whitespace was normalized, so they are not the same text and
    // replaceAll would not reach all of them.
    return (
      `Error: oldString matches ${match.count} places in ${input.path} once ` +
      "whitespace is ignored, so it is not clear which one to change. Send a " +
      "longer oldString, with more of the lines around it, so it points at " +
      "exactly one place."
    );
  }

  const near = nearestRegion(content, input.oldString);
  const total = countLines(content);
  if (!near) {
    return (
      `Error: oldString not found in ${input.path}, and no similar text is ` +
      `in the file (${total} lines). Re-read the file with read_file and ` +
      "copy the exact text you want to change; do not retype it from memory."
    );
  }
  return (
    `Error: oldString not found in ${input.path} (${total} lines). The ` +
    `closest text in the file is lines ${near.from}-${near.to}. Copy it ` +
    "EXACTLY as shown below — same indentation, same spacing — into " +
    `oldString:\n${near.excerpt}`
  );
}

/** A miss whose replacement is already in the file is a completed edit. */
function isAlreadyApplied(content: string, input: EditInput): boolean {
  const target = input.newString.trim();
  // Short replacements are the false-positive risk here: `}` or
  // `onClick={send}` appear all over a file, and reading one as proof the
  // edit landed would talk the model out of a change it still owes. Only a
  // replacement distinctive enough to be its own evidence counts, and
  // telling a model to stop is the expensive mistake to get wrong.
  if (target.length < MIN_APPLIED_EVIDENCE) return false;
  if (occurrences(content, input.newString) > 0) return true;
  return normalizeAll(content).includes(normalizeAll(input.newString));
}

async function readOrNull(
  files: EditFileReader,
  relPath: string
): Promise<string | null> {
  try {
    return (await files.readFile(relPath)).content;
  } catch {
    // Missing, binary, too large, outside the workspace — all cases the
    // shared tool reports better than a repair pass could.
    return null;
  }
}

// --- matching ------------------------------------------------------------

interface Match {
  /** Text that really is in the file, ready for an exact replacement. */
  oldString: string;
  /** The replacement, aligned to the file's line endings and indentation. */
  newString: string;
  count: number;
  tier: Tier;
}

/**
 * Exact first, then progressively looser, stopping at the first tier that
 * finds anything. Order matters: a tighter tier's match is always the more
 * likely intent, so leniency never overrides a real hit.
 */
export function matchEdit(
  content: string,
  oldString: string,
  newString: string
): Match | null {
  if (!oldString) return null;

  // Tier 1 + 2: byte-exact, then the file's line-ending convention. Reused
  // from the shared matcher so both paths agree on what "exact" means.
  const direct = resolveEdit(content, oldString, newString);
  if (direct.count > 0) {
    return {
      oldString: direct.oldString,
      newString: direct.newString,
      count: direct.count,
      tier: direct.oldString === oldString ? "exact" : "eol",
    };
  }

  return (
    // Tier 3: the model dropped (or added) whitespace at line ends.
    windowMatch(content, oldString, newString, trimEnd, "trailing-space") ??
    // Tier 4: the block is right but sits at a different indent.
    windowMatch(content, oldString, newString, (s) => s.trim(), "indent")
  );
}

/**
 * Line-window scan: every line of `oldString` must equal the file's line
 * under `norm`, and the match is reported as the file's own bytes for that
 * span. Whole lines only — a normalizer cannot be applied to a fragment
 * without guessing where the fragment's whitespace belongs.
 */
function windowMatch(
  content: string,
  oldString: string,
  newString: string,
  norm: (line: string) => string,
  tier: Tier
): Match | null {
  const hay = splitKeepEol(content);
  const needle = splitKeepEol(oldString);
  const span = needle.length;
  if (span === 0 || span > hay.length || hay.length > MAX_SCAN_LINES) {
    return null;
  }

  const wanted = needle.map((line) => norm(stripEol(line)));
  const starts: number[] = [];
  for (let i = 0; i + span <= hay.length; i++) {
    let hit = true;
    for (let j = 0; j < span; j++) {
      if (norm(stripEol(hay[i + j]!)) !== wanted[j]) {
        hit = false;
        break;
      }
    }
    if (!hit) continue;
    starts.push(i);
    // Non-overlapping, so the count means the same thing the shared
    // matcher's count means.
    i += span - 1;
  }
  if (starts.length === 0) return null;

  const region = regionAt(hay, starts[0]!, span, oldString);
  return {
    oldString: region,
    newString: alignNewString(content, region, oldString, newString, tier),
    count: starts.length,
    tier,
  };
}

/** The file's own text for a matched span, ending the way oldString ended. */
function regionAt(
  hay: string[],
  start: number,
  span: number,
  oldString: string
): string {
  const region = hay.slice(start, start + span).join("");
  // oldString stopped mid-line, so the replacement must too — otherwise the
  // edit would swallow a newline the model never asked to touch.
  return /\n$/.test(oldString) ? region : region.replace(/\r?\n$/, "");
}

/**
 * Puts the replacement in the file's terms: its line endings always, and
 * its indentation when the match was found by ignoring indentation. A
 * block pasted at the model's indent instead of the file's is a diff that
 * compiles and reads wrong, which is worse than a failed edit.
 */
function alignNewString(
  content: string,
  region: string,
  oldString: string,
  newString: string,
  tier: Tier
): string {
  const eolFixed = usesCrlf(content) ? toCrlf(newString) : toLf(newString);
  if (tier !== "indent") return eolFixed;

  const from = firstIndent(oldString);
  const to = firstIndent(region);
  if (from === null || to === null || from === to) return eolFixed;

  if (to.startsWith(from)) return indentBy(eolFixed, to.slice(from.length));
  if (from.startsWith(to)) return dedentBy(eolFixed, from.slice(to.length));
  // Tabs against spaces: no honest conversion, so the text goes in as
  // written rather than mangled by a guess.
  return eolFixed;
}

/** Leading whitespace of the first line with anything on it. */
function firstIndent(text: string): string | null {
  for (const line of splitKeepEol(text)) {
    const bare = stripEol(line);
    if (!bare.trim()) continue;
    return /^[ \t]*/.exec(bare)![0];
  }
  return null;
}

function indentBy(text: string, prefix: string): string {
  return mapLines(text, (line) => (line.trim() ? prefix + line : line));
}

function dedentBy(text: string, prefix: string): string {
  return mapLines(text, (line) =>
    line.startsWith(prefix) ? line.slice(prefix.length) : line
  );
}

function mapLines(text: string, fn: (line: string) => string): string {
  return splitKeepEol(text)
    .map((line) => {
      const eol = /\r?\n$/.exec(line)?.[0] ?? "";
      return fn(line.slice(0, line.length - eol.length)) + eol;
    })
    .join("");
}

// --- nearest match -------------------------------------------------------

interface NearestRegion {
  from: number;
  to: number;
  excerpt: string;
}

/** Below this the "closest text" is not close enough to be worth quoting. */
const MIN_ANCHOR_SIMILARITY = 0.34;

/**
 * The passage in the file that the model was probably aiming at, quoted
 * with line numbers. This is the whole point of the rewritten error: told
 * only "not found", a model retypes its guess; handed the file's real
 * lines, it copies them.
 *
 * Anchored on one line rather than scored window by window — the failing
 * oldString is usually right about WHICH code it means and wrong about how
 * that code is spelled, so the most distinctive line locates the passage
 * for a fraction of the work.
 */
function nearestRegion(content: string, oldString: string): NearestRegion | null {
  const hay = splitKeepEol(content);
  const needle = splitKeepEol(oldString).map((line) => stripEol(line));
  if (hay.length === 0 || hay.length > MAX_SCAN_LINES) return null;

  // The longest line carries the most signal; a lone brace matches
  // everywhere and would anchor on noise.
  let anchorAt = -1;
  let anchorTokens: string[] = [];
  needle.forEach((line, i) => {
    const tokens = tokenize(line);
    if (tokens.length > anchorTokens.length) {
      anchorTokens = tokens;
      anchorAt = i;
    }
  });
  if (anchorAt < 0 || anchorTokens.length === 0) return null;

  let bestAt = -1;
  let best = MIN_ANCHOR_SIMILARITY;
  for (let i = 0; i < hay.length; i++) {
    const score = similarity(anchorTokens, tokenize(stripEol(hay[i]!)));
    if (score > best) {
      best = score;
      bestAt = i;
    }
  }
  if (bestAt < 0) return null;

  // Line the excerpt up the way oldString was written, so the model sees
  // the anchor with the same neighbours it sent.
  const span = Math.min(Math.max(needle.length, 1), MAX_EXCERPT_LINES);
  const from = Math.max(0, Math.min(bestAt - anchorAt, hay.length - 1));
  const to = Math.min(hay.length, from + span);
  const excerpt = hay
    .slice(from, to)
    .map((line, i) => `${from + i + 1} | ${clip(stripEol(line))}`)
    .join("\n");
  return { from: from + 1, to, excerpt };
}

/** Identifier-ish words, which is what two versions of a line share. */
function tokenize(line: string): string[] {
  const seen = new Set(
    line
      .toLowerCase()
      .split(/[^a-z0-9_$]+/)
      .filter((token) => token.length > 0)
  );
  return [...seen];
}

/** Dice coefficient over token sets: 1 identical, 0 nothing in common. */
function similarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const other = new Set(b);
  const shared = a.filter((token) => other.has(token)).length;
  return (2 * shared) / (a.length + b.length);
}

function clip(line: string): string {
  return line.length > MAX_EXCERPT_COLS
    ? `${line.slice(0, MAX_EXCERPT_COLS)}…`
    : line;
}

// --- text helpers --------------------------------------------------------

/** Splits after each newline, so every piece carries its own terminator. */
function splitKeepEol(text: string): string[] {
  return text.split(/(?<=\n)/);
}

function stripEol(line: string): string {
  return line.replace(/\r?\n$/, "");
}

function trimEnd(line: string): string {
  return line.replace(/[ \t]+$/, "");
}

/** Whitespace-insensitive comparison text, for the already-applied check. */
function normalizeAll(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function usesCrlf(text: string): boolean {
  return text.includes("\r\n");
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function toCrlf(text: string): string {
  return toLf(text).replace(/\n/g, "\r\n");
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

function countLines(text: string): number {
  return text.split(/\r?\n/).length;
}
