import fs from "node:fs";
import path from "node:path";
import { toPosix } from "@atelier/shared";
import {
  inScope,
  scopeGlob,
  type SessionScope,
} from "../workspace/scope/index.js";

/** Tools whose named path must be inside the lock. */
const PATH_FIELD: Record<string, string> = {
  read_file: "path",
  write_file: "path",
  replace_code: "path",
  create_file: "path",
  delete_file: "path",
  move_file: "path",
};

/** Tools carrying a list of path-bearing entries. */
const PATH_LIST: Record<string, string> = {
  read_many_files: "files",
  replace_many: "edits",
};

/** Search tools whose optional glob is clamped instead of rejected. */
const GLOB_FIELD: Record<string, string> = {
  search_workspace: "glob",
  search_text: "glob",
  retrieve_knowledge: "pathGlob",
};

/**
 * Enforces the conversation's working-set lock at the tool boundary.
 *
 * The lock is stated in the system prompt too, but a prompt rule is a
 * request and this is the part that actually holds: the failure it exists
 * for was the agent reading a same-named file out of two projects the
 * user never mentioned, which no amount of instruction reliably prevents.
 * Only tasks with a bound scope are checked — UI-driven tool calls and
 * unlocked conversations pass through untouched.
 */
export class ScopeGuard {
  private active = new Map<string, SessionScope>();
  /** Outside-lock paths this task was let through to, so a retry is silent. */
  private granted = new Map<string, Set<string>>();

  constructor(
    private deps: {
      workspaceRoot: string;
      /**
       * Whether a file with this basename exists under any of the locked
       * roots. That twin is the whole hazard the lock guards against; when
       * there is none, an existing file outside the lock is unambiguous.
       */
      twinExists: (roots: string[], basename: string) => boolean;
      /**
       * True only for an external path the runtime registered as a read-only
       * reference (for example, an installed skill). These reads are runtime
       * context and must not become part of a project/folder lock.
       */
      readReference?: (candidatePath: string) => boolean;
      /** Told when a task is let outside its lock, for the rail and log. */
      onEscape?: (taskId: string, path: string, tool: string) => void;
    } = { workspaceRoot: process.cwd(), twinExists: () => false }
  ) {}

  bind(taskId: string, scope: SessionScope): void {
    if (scope.roots.length === 0) {
      this.active.delete(taskId);
      return;
    }
    this.active.set(taskId, scope);
  }

  release(taskId: string): void {
    this.active.delete(taskId);
    this.granted.delete(taskId);
  }

  /**
   * Whether an out-of-lock path may pass anyway.
   *
   * The lock exists for ONE hazard: the same-named file in a project the
   * user never mentioned. It does not exist to strand a task on a file
   * that is plainly the one it needs — an existing path with no twin under
   * the lock, reached from retrieval or from an earlier turn's memory. That
   * refusal is how a session locked to one app answered a request about
   * another with "cannot read or edit the target file" and gave up. Such a
   * path is let through and reported; a path with a twin, or one that does
   * not exist yet (a create outside the lock), is still refused.
   */
  private mayEscape(
    taskId: string,
    scope: SessionScope,
    tool: string,
    target: string
  ): boolean {
    const rel = toPosix(target).replace(/^\.\//, "");
    if (this.granted.get(taskId)?.has(rel)) return true;
    if (!this.existsInWorkspace(rel)) return false;
    if (this.deps.twinExists(scope.roots, path.posix.basename(rel))) {
      return false;
    }
    let paths = this.granted.get(taskId);
    if (!paths) {
      paths = new Set();
      this.granted.set(taskId, paths);
    }
    paths.add(rel);
    this.deps.onEscape?.(taskId, rel, tool);
    return true;
  }

  private existsInWorkspace(rel: string): boolean {
    if (path.isAbsolute(rel) || rel.includes("..")) return false;
    try {
      return fs.statSync(path.resolve(this.deps.workspaceRoot, rel)).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Returns the input to run — rewritten when a search can simply be
   * narrowed — or throws when a read or write leaves the lock.
   */
  check(name: string, input: unknown, taskId: string): unknown {
    const scope = this.active.get(taskId);
    if (!scope || !isRecord(input)) return input;

    const field = PATH_FIELD[name];
    if (field) {
      const value = input[field];
      if (
        typeof value === "string" &&
        !inScope(scope, value) &&
        !this.isRegisteredRead(name, value) &&
        !this.mayEscape(taskId, scope, name, value)
      ) {
        throw new Error(denial(name, value, scope, this.hasTwin(scope, value)));
      }
      return input;
    }

    const listField = PATH_LIST[name];
    if (listField) {
      const entries = input[listField];
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          const entryPath = isRecord(entry) ? entry.path : undefined;
          if (
            typeof entryPath === "string" &&
            !inScope(scope, entryPath) &&
            !this.isRegisteredRead(name, entryPath) &&
            !this.mayEscape(taskId, scope, name, entryPath)
          ) {
            throw new Error(
              denial(name, entryPath, scope, this.hasTwin(scope, entryPath))
            );
          }
        }
      }
      return input;
    }

    const globField = GLOB_FIELD[name];
    if (globField) {
      // Undefined for a multi-root lock, which has no expressible glob —
      // there the search runs wide and the read guard above is what holds.
      const clamp = scopeGlob(scope);
      if (!clamp) return input;

      const existing = input[globField];
      // A caller-supplied glob is left alone when it already sits inside
      // the lock; only a wider one gets replaced.
      if (typeof existing === "string" && existing.length > 0) {
        return inScopeGlob(scope, existing)
          ? input
          : { ...input, [globField]: clamp };
      }
      return { ...input, [globField]: clamp };
    }

    return input;
  }

  private isRegisteredRead(tool: string, target: string): boolean {
    return (
      (tool === "read_file" || tool === "read_many_files") &&
      this.deps.readReference?.(target) === true
    );
  }

  private hasTwin(scope: SessionScope, target: string): boolean {
    return this.deps.twinExists(scope.roots, path.posix.basename(toPosix(target)));
  }
}

function denial(
  name: string,
  target: string,
  scope: SessionScope,
  twin: boolean
): string {
  const roots = scope.roots.map((root) => `${root}/`).join(", ");
  const why = twin
    ? "A file with this name also exists inside the lock; that is the one " +
      "this session is about — use it. "
    : "The path does not exist in the workspace, so it cannot be created " +
      "outside the lock. ";
  return (
    `"${target}" is outside this session's scope. This conversation is ` +
    `locked to ${roots} — ${name} may only touch paths under ` +
    `${scope.roots.length === 1 ? "that prefix" : "those prefixes"}. ` +
    why +
    "If the work truly needs this path, say so in your report as a blocker " +
    "the user must resolve by widening the scope."
  );
}

/** True when a caller's glob is already confined to the locked roots. */
function inScopeGlob(scope: SessionScope, glob: string): boolean {
  const cleaned = glob.replace(/^\.\//, "");
  return scope.roots.some(
    (root) => cleaned === root || cleaned.startsWith(`${root}/`)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Whether a file called `basename` exists anywhere under `absDir`, walking
 * the tree while skipping ignored folders. Bounded — a workspace with a
 * hundred thousand files must not turn one guard check into a scan — so
 * a huge tree may answer "no" where the index would have said "yes"; the
 * index is asked first for exactly that reason.
 */
export function fileNamedUnder(
  absDir: string,
  basename: string,
  ignore: { ignoresAbsolute(absPath: string, isDir?: boolean): boolean },
  budget = 20_000
): boolean {
  const stack = [absDir];
  let visited = 0;
  while (stack.length > 0 && visited < budget) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || ignore.ignoresAbsolute(abs, true)) continue;
        stack.push(abs);
      } else if (entry.name === basename) {
        return true;
      }
    }
  }
  return false;
}
