import type { EventBus } from "../events/event-bus.js";
import type { HookDecision, HookGuardContext } from "./hooks-engine.js";

export const REPEAT_CALL_HOOK_ID = "builtin-repeat-call";
export const REPEAT_CALL_HOOK_NAME = "Reuse a lookup instead of rerunning it";

/**
 * Read-only lookups whose answer cannot change until the workspace does.
 * Mutations, terminal runs, and git operations are never matched: rerunning
 * one is often the whole point.
 */
export const REPEAT_CALL_MATCHER =
  "search_text|search_workspace|search_symbols|retrieve_knowledge|" +
  "query_knowledge_graph|read_file|read_many_files|list_dir";
const REPEATABLE = new Set(REPEAT_CALL_MATCHER.split("|"));

/** Tasks kept in the ledger; old ones are dropped oldest-first. */
const MAX_TASKS = 32;

/** Distinct calls remembered per task. Well past any honest turn. */
const MAX_CALLS = 400;

/** Result paths quoted back in a refusal. */
const MAX_PATHS = 5;

interface PriorCall {
  /** Which call of the turn this was, so the refusal can point at it. */
  ordinal: number;
  paths: string[];
  /** An earlier TURN ran it, not this one — the refusal reads differently. */
  earlier?: boolean;
}

/**
 * Stops a turn from asking the same question twice.
 *
 * A turn was observed spending seventy-nine tool calls on a git question:
 * seven near-identical search_text runs over the same five symbols, each
 * landing on the same file and re-confirming what the previous one had
 * already returned, plus re-reads of files that were still in context.
 * Nothing in the app had an opinion about it. Every other guard here
 * judges what a call CONTAINS — is the query grounded, is the path in
 * scope, is this rewrite really a patch — and none of them count.
 *
 * The grounding guard could not help, and in fact pointed the other way:
 * its documented escape hatch is repetition, and every tool result is fed
 * back into its vocabulary, so the second search for a term the first one
 * returned is perfectly grounded and never even reaches a decision.
 * Working memory knew — noteSearch stores `tool:query` as a dedup key, and
 * it is written live during the turn — but it is only ever read back at
 * turn start, so the fact sat in a store nobody consults until the turn it
 * describes is over.
 *
 * So the ledger is consulted live. A repeat of an identical read-only
 * lookup is refused with the call number that already answered it and the
 * files that answer pointed at, which is the thing the model wanted and a
 * fraction of the tokens a rerun would cost.
 *
 * Like every other guard here, it is a SPEED BUMP, not a wall: refused
 * once, and an immediate repeat of the same call goes through. That is the
 * house convention and departing from it was a mistake — an unbypassable
 * refusal turns into a deadlock the moment its premise is wrong, and this
 * one's premise (the answer is already in your context) can be wrong for
 * reasons the guard cannot see. The bump still removes the reflex, which
 * is the whole cost being saved; what it no longer does is make a turn
 * unable to proceed. An applied edit clears the ledger outright, because a
 * search before a change and the same search after it are two different
 * questions.
 */
export class RepeatCallGuard {
  /** taskId → call key → what it returned the first time. */
  private seen = new Map<string, Map<string, PriorCall>>();
  /** taskId → calls noted so far, for the ordinal in the refusal. */
  private counts = new Map<string, number>();
  /** taskId → call keys already refused once; a repeat of one goes through. */
  private refused = new Map<string, Set<string>>();

  constructor(private bus: EventBus) {}

  /**
   * Records a finished lookup. Called from the pipeline's own bus
   * subscription — the same place working memory and the grounding guard
   * are fed — because only a completed call knows what it pointed at.
   */
  note(taskId: string, name: string, input: unknown, result: unknown): void {
    if (!REPEATABLE.has(name)) return;
    const key = callKey(name, input);
    if (!key) return;
    const ordinal = (this.counts.get(taskId) ?? 0) + 1;
    this.counts.set(taskId, ordinal);
    const calls = this.ledgerFor(taskId);
    if (calls.has(key) || calls.size >= MAX_CALLS) return;
    // A read answers with content, not a path, so the file it names is in
    // the arguments. Falling back to those keeps the refusal specific.
    const paths = pathsFrom(result);
    calls.set(key, {
      ordinal,
      paths: paths.length > 0 ? paths : pathsFrom(input),
    });
  }

  /**
   * Seeds the ledger with what EARLIER turns of this conversation already
   * looked up, so the no-re-investigation rule is enforced and not merely
   * stated. Called once at turn start, from the same recall that renders
   * those findings into the prompt — the guard refuses exactly what the
   * model was just handed.
   *
   * Two kinds only, and for different reasons. A search is seeded outright:
   * its answer is a fact about the codebase that the carried block already
   * states. A read is seeded ONLY when this turn's context inlined the
   * file's CURRENT bytes, because a read is the one lookup whose answer
   * legitimately changes between turns — recall re-reads from disk, so a
   * file it did not inline is a file the model has no fresh copy of and
   * must be allowed to open.
   */
  seedEarlier(
    taskId: string,
    earlier: { searches: Array<{ tool: string; query: string; paths: string[] }>; inlinedPaths: string[] }
  ): void {
    const calls = this.ledgerFor(taskId);
    for (const search of earlier.searches) {
      if (!REPEATABLE.has(search.tool)) continue;
      const key = callKey(search.tool, { query: search.query });
      if (!key || calls.has(key) || calls.size >= MAX_CALLS) continue;
      calls.set(key, { ordinal: 0, paths: search.paths ?? [], earlier: true });
    }
    for (const path of earlier.inlinedPaths) {
      const key = callKey("read_file", { path });
      if (!key || calls.has(key) || calls.size >= MAX_CALLS) continue;
      calls.set(key, { ordinal: 0, paths: [path], earlier: true });
    }
  }

  /**
   * The workspace changed, so every answer gathered before it is stale.
   * Called on edit.applied; cheaper and more honest than working out
   * which lookups a given file invalidates.
   */
  invalidate(taskId: string): void {
    this.seen.delete(taskId);
    this.refused.delete(taskId);
  }

  /** The turn is over; its ledger goes with it. */
  release(taskId: string): void {
    this.seen.delete(taskId);
    this.counts.delete(taskId);
    this.refused.delete(taskId);
  }

  async check(ctx: HookGuardContext): Promise<HookDecision | undefined> {
    if (!REPEATABLE.has(ctx.toolName)) return undefined;
    const key = callKey(ctx.toolName, ctx.input);
    if (!key) return undefined;
    const prior = this.seen.get(ctx.taskId)?.get(key);
    if (!prior) return undefined;
    // Refused once already — the model is insisting, so let it through.
    const already = this.refused.get(ctx.taskId);
    if (already?.has(key)) return undefined;
    if (already) already.add(key);
    else this.refused.set(ctx.taskId, new Set([key]));

    const where =
      prior.paths.length > 0
        ? ` It returned: ${prior.paths.join(", ")}.`
        : " It returned nothing, and nothing has changed since.";
    const ran = prior.earlier
      ? `An earlier turn of this conversation already ran this exact ` +
        `${ctx.toolName} call, and its result is in the context you were ` +
        "given this turn — under PREVIOUSLY GATHERED CONTEXT, or the " +
        "FEATURE WIKI Flow."
      : `This exact ${ctx.toolName} call already ran as call ` +
        `${prior.ordinal} of this turn.`;
    const reason =
      `${ran}${where} Use that answer instead of rerunning it. If ` +
      "you need more than the result gave you, ask a DIFFERENT question — " +
      "read one of those files, or narrow the query — rather than repeating " +
      "this one. If you truly need it run again, repeat this exact call and " +
      "it will be allowed.";
    this.bus.publish(
      "hook.blocked",
      { hookId: REPEAT_CALL_HOOK_ID, name: REPEAT_CALL_HOOK_NAME, reason },
      ctx.taskId
    );
    return { allowed: false, reason };
  }

  private ledgerFor(taskId: string): Map<string, PriorCall> {
    const existing = this.seen.get(taskId);
    if (existing) return existing;
    const calls = new Map<string, PriorCall>();
    this.seen.set(taskId, calls);
    // Map keeps insertion order, so the first key is the oldest task.
    if (this.seen.size > MAX_TASKS) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) {
        this.seen.delete(oldest.value);
        this.counts.delete(oldest.value);
      }
    }
    return calls;
  }
}

/**
 * Identity of a call: the tool plus its arguments, normalized so that two
 * spellings of the same question collide. Keys are sorted (argument order
 * is not meaning), strings are trimmed and lowercased, and paths are
 * posix-ified — `./Src/App.tsx` and `src/app.tsx` are one read.
 */
export function callKey(name: string, input: unknown): string | null {
  if (input === null || input === undefined) return name;
  if (typeof input !== "object") return `${name}|${normalizeValue(input)}`;
  const record = input as Record<string, unknown>;
  const parts = Object.keys(record)
    .sort()
    .map((key) => `${key}=${normalizeValue(record[key])}`)
    .filter((part) => !part.endsWith("="));
  return parts.length > 0 ? `${name}|${parts.join("&")}` : name;
}

function normalizeValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(normalizeValue).join(",");
  return JSON.stringify(value);
}

/**
 * The paths a result pointed at, whatever shape it came in. Every lookup
 * tool answers with paths somewhere — matches[].path, entries[].path, a
 * bare path on a read — so the walk is tolerant rather than per-tool.
 */
export function pathsFrom(result: unknown): string[] {
  const found: string[] = [];
  walk(result, found, 0);
  return [...new Set(found)].slice(0, MAX_PATHS);
}

function walk(value: unknown, found: string[], depth: number): void {
  if (found.length >= MAX_PATHS * 4 || depth > 4) return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, found, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ["path", "file", "filePath", "relPath"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      found.push(candidate.trim());
      break;
    }
  }
  for (const nested of Object.values(record)) {
    if (nested && typeof nested === "object") walk(nested, found, depth + 1);
  }
}
