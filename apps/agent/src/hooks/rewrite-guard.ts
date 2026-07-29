import type { EventBus } from "../events/event-bus.js";
import type { HookDecision, HookGuardContext } from "./hooks-engine.js";

export const REWRITE_HOOK_ID = "builtin-targeted-edit";
export const REWRITE_HOOK_NAME = "Targeted edit over whole-file rewrite";

/** Only the whole-file tool is gated; the patch tools are the goal. */
const REWRITE_TOOL = "write_file";

/** Files this short cost nothing to rewrite, so they are left alone. */
const MIN_LINES = 40;

/**
 * Share of the original's non-blank lines that survive the rewrite. Above
 * this the write is a patch wearing a rewrite's clothes. Deliberately
 * lenient: a real reimplementation keeps far less than four fifths.
 */
const PATCH_SIMILARITY = 0.8;

/** Tasks kept in the ledger; old ones are dropped oldest-first. */
const MAX_TASKS = 32;

/** Reads a workspace file, or null when it does not exist / is unreadable. */
export type ReadFileText = (relPath: string) => Promise<string | null>;

/**
 * Keeps whole-file rewrites honest.
 *
 * write_file is the only tool that can restate a file the model never
 * needed to restate, and nothing about it announces the cost: the entire
 * file goes out in the request, comes back in the response, and lands as
 * a diff the reviewer has to read in full to find the three lines that
 * actually changed. Worse, every untouched line is a line the model can
 * silently drop.
 *
 * So this refuses a write_file whose output is mostly the file that was
 * already there, and names the tool that fits. It measures how much
 * survives rather than how many bytes were sent, because size alone
 * cannot tell a genuine reimplementation from a lazy patch — a rewrite
 * that keeps four fifths of its lines is a patch by any other name.
 *
 * It is a speed bump, not a wall: the refusal is remembered per task and
 * path, so a model that repeats the same write_file gets through. New
 * files, short files, and both patch tools are never touched.
 */
export class TargetedEditGuard {
  /** taskId → paths already refused once. */
  private warned = new Map<string, Set<string>>();

  constructor(
    private readFile: ReadFileText,
    private bus: EventBus
  ) {}

  async check(ctx: HookGuardContext): Promise<HookDecision | undefined> {
    if (ctx.toolName !== REWRITE_TOOL) return undefined;

    const { path, content } = rewriteTarget(ctx.input);
    if (!path || content === null) return undefined;
    if (this.warned.get(ctx.taskId)?.has(normalize(path))) return undefined;

    const before = await this.readFile(path);
    if (before === null) return undefined; // new file: nothing to patch

    const kept = survivingShare(before, content);
    if (kept === null || kept < PATCH_SIMILARITY) return undefined;

    // Refused once — a repeat of this exact write goes through.
    this.remember(ctx.taskId, path);
    const percent = Math.round(kept * 100);
    const reason =
      `write_file would restate ${path} with ${percent}% of its existing ` +
      "lines unchanged, so this is a patch, not a rewrite. Use replace_code " +
      "for the lines that actually change (or replace_many for several " +
      "edits at once): it keeps the untouched lines out of the diff, which " +
      "is both cheaper and impossible to accidentally drop text from. If " +
      "the file genuinely has to be restated in full, repeat this call and " +
      "it will be allowed.";
    this.bus.publish(
      "hook.blocked",
      { hookId: REWRITE_HOOK_ID, name: REWRITE_HOOK_NAME, reason },
      ctx.taskId
    );
    return { allowed: false, reason };
  }

  private remember(taskId: string, path: string): void {
    let paths = this.warned.get(taskId);
    if (!paths) {
      paths = new Set();
      this.warned.set(taskId, paths);
      // Map keeps insertion order, so the first key is the oldest task.
      if (this.warned.size > MAX_TASKS) {
        const oldest = this.warned.keys().next();
        if (!oldest.done) this.warned.delete(oldest.value);
      }
    }
    paths.add(normalize(path));
  }
}

function rewriteTarget(input: unknown): {
  path: string | null;
  content: string | null;
} {
  if (!input || typeof input !== "object") return { path: null, content: null };
  const record = input as Record<string, unknown>;
  return {
    path: typeof record.path === "string" && record.path ? record.path : null,
    content: typeof record.content === "string" ? record.content : null,
  };
}

/**
 * Fraction of the original's non-blank lines still present afterwards,
 * counted as a multiset so duplicates cannot inflate the score. Blank
 * lines are excluded because they match everywhere and would make every
 * file look similar to every other. Returns null when the file is too
 * short to judge.
 */
function survivingShare(before: string, after: string): number | null {
  const original = meaningfulLines(before);
  if (original.length < MIN_LINES) return null;

  const pool = new Map<string, number>();
  for (const line of meaningfulLines(after)) {
    pool.set(line, (pool.get(line) ?? 0) + 1);
  }
  let kept = 0;
  for (const line of original) {
    const remaining = pool.get(line) ?? 0;
    if (remaining > 0) {
      kept += 1;
      pool.set(line, remaining - 1);
    }
  }
  return kept / original.length;
}

function meaningfulLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Same normalization as the impact guard, so the retry matches. */
function normalize(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .toLowerCase();
}
