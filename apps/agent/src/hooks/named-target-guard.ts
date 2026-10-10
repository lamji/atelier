import type { EventBus } from "../events/event-bus.js";
import type { HookDecision, HookGuardContext } from "./hooks-engine.js";

export const NAMED_TARGET_HOOK_ID = "builtin-named-target";
export const NAMED_TARGET_HOOK_NAME =
  "Look at what the user named before editing elsewhere";

/** Planning and editing wait until the named target has been looked at. */
export const NAMED_TARGET_MATCHER =
  "write_file|replace_code|replace_many|set_plan";
const GATED_TOOLS = new Set(NAMED_TARGET_MATCHER.split("|"));

/** Tools whose query, when it names the target, counts as looking. */
const SEARCH_TOOLS = new Set([
  "search_text",
  "search_workspace",
  "search_symbols",
  "retrieve_knowledge",
  "query_knowledge_graph",
]);

const READ_TOOLS = new Set(["read_file", "read_many_files"]);

/** Tasks kept; old ones are dropped oldest-first. */
const MAX_TASKS = 32;

/** After this many refusals the guard stands down: it may be wrong. */
const MAX_REFUSALS = 3;

/** Targets quoted back in a refusal. */
const MAX_QUOTED = 6;

/** What the user pointed at this turn. */
export interface NamedTargets {
  /** Paths typed in the human prompt, or in set_plan step files. */
  paths: string[];
  /** Quoted strings, dotted keys, on-screen phrases, focused-element text. */
  literals: string[];
}

interface TaskState {
  paths: string[];
  literals: string[];
  /** Something in the turn has read or searched for a named target. */
  looked: boolean;
  refusals: number;
}

/**
 * Makes the turn look at what the user named before it plans or edits
 * anywhere else.
 *
 * The run this exists for was told, with a screenshot and a quoted label,
 * which text was wrong. The model never searched for that text: it grepped
 * a CSS class it had spotted in the hidden preview dump, landed in an
 * unrelated component, planned around it, and edited the wrong file three
 * times while the user kept stopping it. Every guard in play judged the
 * calls it saw — grounded query, in-scope path, observed failure — and
 * every one of them passed, because nothing checks whether the turn ever
 * went where the user pointed.
 *
 * So the pipeline arms this guard with the request's NAMED targets: paths
 * typed by the user, quoted strings, dotted keys, phrases that are visibly
 * on the page. Until some call of the turn has looked at one of them — a
 * read of the file, a search for the text, or an edit that lands on it —
 * write_file / replace_* / set_plan are refused, and the refusal says what
 * to look at. Tool results are not consulted: the point is that the model
 * LOOKS, not that it finds; if the target truly lives elsewhere, the
 * honest way to continue is to go there and say so in the report.
 *
 * It stands down after three refusals. A wrong target list — a phrase the
 * extractor mis-read as a quote — must not wedge a turn.
 */
export class NamedTargetGuard {
  private tasks = new Map<string, TaskState>();

  constructor(private bus: EventBus) {}

  /** Arms a task with what the user named; nothing named, nothing armed. */
  arm(taskId: string, targets: NamedTargets): void {
    const paths = uniq(targets.paths.map(cleanPath));
    const literals = uniq(targets.literals.map(cleanLiteral));
    if (paths.length === 0 && literals.length === 0) {
      this.tasks.delete(taskId);
      return;
    }
    this.tasks.set(taskId, { paths, literals, looked: false, refusals: 0 });
    if (this.tasks.size > MAX_TASKS) {
      const oldest = this.tasks.keys().next().value;
      if (oldest !== undefined) this.tasks.delete(oldest);
    }
  }

  isArmed(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  /** Whether the turn has looked at a named target yet. */
  hasLooked(taskId: string): boolean {
    return this.tasks.get(taskId)?.looked ?? false;
  }

  /**
   * A tool finished. Called from the pipeline's tool.completed subscription;
   * the result is ignored on purpose (see the class comment).
   */
  note(taskId: string, toolName: string, input: unknown, _result?: unknown): void {
    const state = this.tasks.get(taskId);
    if (!state || state.looked) return;
    if (this.callLooks(state, toolName, input)) state.looked = true;
  }

  /** The turn is over. */
  release(taskId: string): void {
    this.tasks.delete(taskId);
  }

  async check(ctx: HookGuardContext): Promise<HookDecision | undefined> {
    if (!GATED_TOOLS.has(ctx.toolName)) return undefined;
    const state = this.tasks.get(ctx.taskId);
    if (!state || state.looked) return undefined;
    // The edit or plan itself lands on the target: that IS looking at it.
    if (this.callLooks(state, ctx.toolName, ctx.input)) {
      state.looked = true;
      return undefined;
    }
    if (state.refusals >= MAX_REFUSALS) return undefined;
    state.refusals += 1;
    const reason =
      `The request names ${quoted(state)}. Nothing in this turn has looked ` +
      "at it yet — read_file the named file or search_text the exact text " +
      "before planning or editing anywhere else. If, after looking, the " +
      "target truly lives elsewhere, continue there and say so in the " +
      "final report.";
    this.bus.publish(
      "hook.blocked",
      { hookId: NAMED_TARGET_HOOK_ID, name: NAMED_TARGET_HOOK_NAME, reason },
      ctx.taskId
    );
    if (state.refusals === MAX_REFUSALS) {
      console.warn(
        `[named-target] standing down for ${ctx.taskId} after ` +
          `${MAX_REFUSALS} refusals: ${quoted(state)}`
      );
    }
    return { allowed: false, reason };
  }

  /** Whether one call, by its arguments alone, looks at a named target. */
  private callLooks(state: TaskState, toolName: string, input: unknown): boolean {
    if (READ_TOOLS.has(toolName)) {
      return readPaths(input).some((path) => namesPath(state, path));
    }
    if (SEARCH_TOOLS.has(toolName)) {
      const query = queryOf(input);
      return query !== null && namesQuery(state, query);
    }
    if (toolName === "set_plan") {
      return planFiles(input).some((path) => namesPath(state, path));
    }
    if (toolName === "write_file" || toolName === "replace_code") {
      const path = stringField(input, "path");
      if (path && namesPath(state, path)) return true;
      const old = stringField(input, "oldString");
      return old !== null && hasLiteral(state, old);
    }
    if (toolName === "replace_many") {
      return editsOf(input).some(
        (edit) =>
          (edit.path !== null && namesPath(state, edit.path)) ||
          (edit.oldString !== null && hasLiteral(state, edit.oldString))
      );
    }
    return false;
  }
}

// ------------------------------------------------------------ matching

/**
 * `src/App.tsx`, `App.tsx` and `./src/app.tsx` all name the same file:
 * the user rarely types a full workspace-relative path, so a basename or a
 * posix suffix is enough.
 */
export function pathMatches(candidate: string, named: string): boolean {
  const a = cleanPath(candidate).toLowerCase();
  const b = cleanPath(named).toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.endsWith("/" + b) || b.endsWith("/" + a)) return true;
  return basename(a) === basename(b);
}

function namesPath(state: TaskState, candidate: string): boolean {
  return state.paths.some((named) => pathMatches(candidate, named));
}

/** A query names the target when it carries a literal or a file's basename. */
function namesQuery(state: TaskState, query: string): boolean {
  if (hasLiteral(state, query)) return true;
  const lower = query.toLowerCase();
  return state.paths.some((named) => {
    const base = basename(cleanPath(named).toLowerCase());
    return base.length > 0 && lower.includes(base);
  });
}

function hasLiteral(state: TaskState, text: string): boolean {
  const haystack = squash(text);
  if (!haystack) return false;
  return state.literals.some((literal) => {
    const needle = squash(literal);
    if (!needle) return false;
    if (haystack.includes(needle)) return true;
    // Searching for a distinctive PART of the named text counts: a model
    // asked about "No budgets configured yet." reasonably greps "No
    // budgets configured". Six squashed characters keeps "the" out.
    return haystack.length >= 6 && needle.includes(haystack);
  });
}

function quoted(state: TaskState): string {
  const items = [...state.paths, ...state.literals]
    .slice(0, MAX_QUOTED)
    .map((item) => `"${item}"`);
  return items.join(", ");
}

// ------------------------------------------------------------- inputs

function readPaths(input: unknown): string[] {
  const single = stringField(input, "path");
  if (single) return [single];
  const files = (input as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return [];
  return files
    .map((item) => (typeof item === "string" ? item : stringField(item, "path")))
    .filter((item): item is string => typeof item === "string" && item !== "");
}

function planFiles(input: unknown): string[] {
  const steps = (input as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return [];
  const out: string[] = [];
  for (const step of steps) {
    const files = (step as { files?: unknown } | null)?.files;
    if (!Array.isArray(files)) continue;
    for (const file of files) if (typeof file === "string") out.push(file);
  }
  return out;
}

function editsOf(input: unknown): Array<{ path: string | null; oldString: string | null }> {
  const edits = (input as { edits?: unknown } | null)?.edits;
  if (!Array.isArray(edits)) return [];
  return edits.map((edit) => ({
    path: stringField(edit, "path"),
    oldString: stringField(edit, "oldString"),
  }));
}

/** query_knowledge_graph asks with `target`; every other search, `query`. */
function queryOf(input: unknown): string | null {
  return stringField(input, "query") ?? stringField(input, "target");
}

function stringField(input: unknown, key: string): string | null {
  if (!input || typeof input !== "object") return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : null;
}

// ------------------------------------------------------------- helpers

function cleanPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function cleanLiteral(literal: string): string {
  return literal.trim();
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Case and whitespace are not meaning when matching on-screen text. */
function squash(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function uniq(items: string[]): string[] {
  return [...new Set(items.filter((item) => item.length > 0))];
}
