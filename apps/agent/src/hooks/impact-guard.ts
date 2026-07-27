import { languageForFile } from "../knowledge/parsing/languages.js";
import type { EventBus } from "../events/event-bus.js";
import type { HookDecision, HookGuardContext } from "./hooks-engine.js";

export const IMPACT_HOOK_ID = "builtin-impact-first";
export const IMPACT_HOOK_NAME = "Impact radius before edit";

/** Tools that count as checking the blast radius of a file. */
const IMPACT_TOOLS = new Set(["impact_of_edit", "analyze_impact"]);

/** Tools that mutate a file and therefore need a radius first. */
const EDIT_TOOLS = new Set(["write_file", "replace_code"]);

/** Tasks kept in the ledger; old ones are dropped oldest-first. */
const MAX_TASKS = 32;

/** Answers whether a workspace-relative path already exists. */
export type FileExists = (relPath: string) => Promise<boolean>;

/**
 * Makes the impact radius a precondition of editing, not a report about it.
 *
 * The pipeline's own radius is computed from the plan's targets — before the
 * model has picked the line it will change — so it can only ever be context.
 * This guard closes that gap at the moment the target is finally concrete:
 * the first write to an existing source file is refused until the model has
 * called impact_of_edit (or analyze_impact) for that exact file, and the
 * denial tells it what to call. The retry then goes through, so a blocked
 * edit costs one tool call, never the task.
 *
 * Only files that can have callers are gated: brand-new files and
 * non-source files (markdown, json, assets) pass untouched.
 */
export class ImpactFirstGuard {
  /** taskId → paths whose radius the model has already asked for. */
  private analyzed = new Map<string, Set<string>>();

  constructor(
    private exists: FileExists,
    private bus: EventBus
  ) {}

  async check(ctx: HookGuardContext): Promise<HookDecision | undefined> {
    // The radius call itself flows through this guard, which is how the
    // ledger stays in sync without the knowledge tools knowing about hooks.
    // Recorded on the attempt, not the result: an impact call that comes
    // back empty ("new or unparsed file") is still the model looking.
    if (IMPACT_TOOLS.has(ctx.toolName)) {
      for (const path of impactTargets(ctx.input)) {
        this.remember(ctx.taskId, path);
      }
      return undefined;
    }
    if (!EDIT_TOOLS.has(ctx.toolName)) return undefined;

    const path = pathOf(ctx.input);
    if (!path) return undefined;
    if (this.analyzed.get(ctx.taskId)?.has(normalize(path))) return undefined;
    // Nothing to be impacted: no symbols to trace, or no file yet.
    if (languageForFile(path) === null) return undefined;
    if (!(await this.exists(path))) return undefined;

    const reason =
      `Impact radius not checked for ${path}. Before editing existing ` +
      "source, call impact_of_edit with that path and the line (or symbol) " +
      "you are about to change — it returns who calls, imports, and " +
      "references it, and whether the site is isolated, local, or shared. " +
      "Use the verdict: if shared and you change the signature or behavior, " +
      "update the callers it lists; otherwise keep the contract stable and " +
      "isolate the change. Then repeat this edit.";
    this.bus.publish(
      "hook.blocked",
      { hookId: IMPACT_HOOK_ID, name: IMPACT_HOOK_NAME, reason },
      ctx.taskId
    );
    return { allowed: false, reason };
  }

  private remember(taskId: string, path: string): void {
    let paths = this.analyzed.get(taskId);
    if (!paths) {
      paths = new Set();
      this.analyzed.set(taskId, paths);
      // Map keeps insertion order, so the first key is the oldest task.
      if (this.analyzed.size > MAX_TASKS) {
        const oldest = this.analyzed.keys().next();
        if (!oldest.done) this.analyzed.delete(oldest.value);
      }
    }
    paths.add(normalize(path));
  }
}

/** The paths an impact call covers — one for impact_of_edit, many for analyze_impact. */
function impactTargets(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const paths: string[] = [];
  if (typeof record.path === "string") paths.push(record.path);
  if (Array.isArray(record.files)) {
    for (const file of record.files) {
      if (typeof file === "string") paths.push(file);
    }
  }
  return paths;
}

function pathOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const path = (input as Record<string, unknown>).path;
  return typeof path === "string" && path !== "" ? path : null;
}

/**
 * Same file, same key: the model may spell a path with backslashes or a
 * "./" prefix between the impact call and the edit, and Windows paths are
 * case-insensitive. A mismatch here would block the retry too.
 */
function normalize(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .toLowerCase();
}
