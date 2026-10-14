import { runOneShot } from "../providers/one-shot.js";
import { sdkModel } from "../providers/model-routing.js";
import * as ops from "./git-ops.js";
import type { GitService } from "./git-service.js";

/**
 * The fast path of the AI resolver: one tool-less model call per file, with
 * the conflicted hunks and a few lines around them already in the prompt.
 *
 * The agent task this sits in front of opens a conversation, plans, reads
 * the file with tools and edits it — minutes of work for a conflict over
 * three import lines. Nearly every conflict is that small, and for those the
 * model needs nothing it cannot be handed up front. A file this cannot
 * resolve (too large, malformed markers, an answer that does not line up) is
 * reported back untouched, and the caller sends it to the agent as before.
 */

const DEFAULT_MODEL = "claude-sonnet-5";
const TIMEOUT_MS = 60_000;
/** Lines of surrounding code shown on each side of a hunk. */
const CONTEXT_LINES = 8;
/** Past these the file is the agent's: it needs reading, not a glance. */
const MAX_HUNKS = 12;
const MAX_HUNK_CHARS = 16_000;

export interface ConflictHunk {
  ours: string[];
  theirs: string[];
  /** The common ancestor, when the file carries diff3 markers. */
  base: string[] | null;
}

export type ConflictSegment =
  | { kind: "text"; lines: string[] }
  | ({ kind: "conflict" } & ConflictHunk);

export interface QuickResolveInput {
  paths: string[];
  /** Label of the side above `=======`. */
  ours: string;
  /** Label of the side below `=======`. */
  theirs: string;
  /** "merge", "rebase", … — a rebase swaps what the two sides mean. */
  kind: string;
  instruction?: string;
  model?: string;
}

export interface QuickResolveResult {
  resolved: string[];
  skipped: Array<{ path: string; reason: string }>;
}

type Asker = (system: string, prompt: string) => Promise<string>;

/**
 * Splits a marked-up file into plain text and conflict hunks.
 *
 * @returns null when the markers do not nest the way git writes them, which
 * means the file was hand-edited mid-conflict and guessing would lose code.
 */
export function splitConflicts(text: string): ConflictSegment[] | null {
  const segments: ConflictSegment[] = [];
  let plain: string[] = [];
  let hunk: ConflictHunk | null = null;
  let side: "ours" | "base" | "theirs" = "ours";

  for (const line of text.split("\n")) {
    const bare = line.replace(/\r$/, "");
    if (/^<{7}( |$)/.test(bare)) {
      if (hunk) return null;
      segments.push({ kind: "text", lines: plain });
      plain = [];
      hunk = { ours: [], theirs: [], base: null };
      side = "ours";
    } else if (hunk && /^\|{7}( |$)/.test(bare)) {
      if (side !== "ours") return null;
      hunk.base = [];
      side = "base";
    } else if (hunk && bare === "=======") {
      if (side === "theirs") return null;
      side = "theirs";
    } else if (hunk && /^>{7}( |$)/.test(bare)) {
      if (side !== "theirs") return null;
      segments.push({ kind: "conflict", ...hunk });
      hunk = null;
    } else if (!hunk) {
      plain.push(line);
    } else if (side === "base") {
      hunk.base?.push(line);
    } else {
      hunk[side].push(line);
    }
  }
  if (hunk) return null;
  segments.push({ kind: "text", lines: plain });
  return segments;
}

function strip(lines: string[]): string {
  return lines.map((line) => line.replace(/\r$/, "")).join("\n");
}

function fenced(label: string, lines: string[]): string {
  const body = lines.length > 0 ? strip(lines) : "(nothing — this side has no lines here)";
  return `${label}:\n\`\`\`\n${body}\n\`\`\``;
}

function hunkPrompt(
  segments: ConflictSegment[],
  index: number,
  number: number,
  input: QuickResolveInput
): string {
  const hunk = segments[index] as ConflictHunk;
  const before = segments[index - 1];
  const after = segments[index + 1];
  const above = before?.kind === "text" ? before.lines.slice(-CONTEXT_LINES) : [];
  const below = after?.kind === "text" ? after.lines.slice(0, CONTEXT_LINES) : [];
  return [
    `## Conflict ${number}`,
    fenced("Unchanged lines just above", above),
    fenced(`OURS (${input.ours})`, hunk.ours),
    ...(hunk.base ? [fenced("BASE (common ancestor)", hunk.base)] : []),
    fenced(`THEIRS (${input.theirs})`, hunk.theirs),
    fenced("Unchanged lines just below", below),
  ].join("\n\n");
}

function systemPrompt(input: QuickResolveInput): string {
  const rebase =
    input.kind === "rebase"
      ? " This is a REBASE, so the labels are swapped from what they suggest: " +
        "OURS is the upstream commit being rebased onto and THEIRS is the " +
        "user's own commit being replayed; prefer the user's intent when the " +
        "two genuinely clash."
      : "";
  return (
    "You resolve git merge conflicts. For each numbered conflict you are " +
    "given both sides and the unchanged lines around them. Write the lines " +
    "that should REPLACE the conflicted region so the result keeps both " +
    "intents wherever they are compatible; when they truly contradict, keep " +
    "the more recent or more complete change. Lines that are identical on " +
    "both sides appear once. Never repeat the unchanged context lines, " +
    "never output conflict markers, and keep the indentation exactly." +
    rebase +
    "\n\nRespond with ONLY one block per conflict, in order, in this exact " +
    "form and nothing else:\n" +
    "<<RESOLVED 1>>\n(the replacement lines)\n<<END 1>>\n" +
    "A conflict whose resolution is to delete every line is an empty block."
  );
}

/** `<<RESOLVED n>> … <<END n>>` blocks, keyed by their number. */
export function parseResolutions(reply: string): Map<number, string> {
  const blocks = new Map<number, string>();
  const pattern = /<<RESOLVED (\d+)>>\r?\n?([\s\S]*?)\r?\n?<<END \1>>/g;
  for (const match of reply.matchAll(pattern)) {
    blocks.set(Number(match[1]), (match[2] ?? "").replace(/\r\n/g, "\n"));
  }
  return blocks;
}

const MARKER_LINE = /^(<{7}|={7}|>{7}|\|{7})( |$)/m;

/**
 * Resolves one file's text.
 *
 * @returns the merged text, or the reason it was left alone.
 */
export async function resolveText(
  text: string,
  input: QuickResolveInput,
  ask: Asker
): Promise<{ content: string } | { reason: string }> {
  const segments = splitConflicts(text);
  if (!segments) return { reason: "the conflict markers are malformed" };
  const hunks = segments.flatMap((segment, index) =>
    segment.kind === "conflict" ? [index] : []
  );
  if (hunks.length === 0) return { reason: "no conflict markers left" };
  if (hunks.length > MAX_HUNKS) return { reason: `${hunks.length} conflicts` };

  const prompts = hunks.map((index, n) => hunkPrompt(segments, index, n + 1, input));
  const body = prompts.join("\n\n");
  if (body.length > MAX_HUNK_CHARS) return { reason: "the conflicts are large" };

  const extra = input.instruction?.trim();
  const reply = await ask(
    systemPrompt(input),
    (extra ? `Instructions from the user: ${extra}\n\n` : "") + body
  );
  const blocks = parseResolutions(reply);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const out: string[] = [];
  let number = 0;
  for (const segment of segments) {
    if (segment.kind === "text") {
      out.push(...segment.lines);
      continue;
    }
    number += 1;
    const resolved = blocks.get(number);
    if (resolved === undefined) return { reason: "the model skipped a conflict" };
    if (MARKER_LINE.test(resolved)) return { reason: "the answer kept markers" };
    if (resolved === "") continue;
    const tail = eol === "\r\n" ? "\r" : "";
    out.push(...resolved.split("\n").map((line) => line + tail));
  }
  return { content: out.join("\n") };
}

function asker(model: string | undefined, cwd: string): Asker {
  return async (system, prompt) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    try {
      return await runOneShot({
        model,
        claudeFallback: sdkModel(model) ?? DEFAULT_MODEL,
        system,
        prompt,
        cwd,
        signal: abort.signal,
        effort: "low",
      });
    } catch (error) {
      if (abort.signal.aborted) throw new Error("the model timed out");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Resolves and stages every file it can, all at once. A file it could not
 * resolve is left exactly as it was.
 */
export async function quickResolveConflicts(
  git: GitService,
  input: QuickResolveInput
): Promise<QuickResolveResult> {
  const ask = asker(input.model, git.root);
  const result: QuickResolveResult = { resolved: [], skipped: [] };
  await Promise.all(
    input.paths.map(async (relPath) => {
      try {
        const outcome = await resolveText(git.readWorking(relPath), input, ask);
        if ("reason" in outcome) {
          result.skipped.push({ path: relPath, reason: outcome.reason });
          return;
        }
        await ops.resolveConflict(git, relPath, outcome.content, true);
        result.resolved.push(relPath);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        result.skipped.push({ path: relPath, reason });
      }
    })
  );
  return result;
}
