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

  bind(taskId: string, scope: SessionScope): void {
    if (scope.roots.length === 0) {
      this.active.delete(taskId);
      return;
    }
    this.active.set(taskId, scope);
  }

  release(taskId: string): void {
    this.active.delete(taskId);
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
      if (typeof value === "string" && !inScope(scope, value)) {
        throw new Error(denial(name, value, scope));
      }
      return input;
    }

    const listField = PATH_LIST[name];
    if (listField) {
      const entries = input[listField];
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          const entryPath = isRecord(entry) ? entry.path : undefined;
          if (typeof entryPath === "string" && !inScope(scope, entryPath)) {
            throw new Error(denial(name, entryPath, scope));
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
}

function denial(
  name: string,
  target: string,
  scope: SessionScope
): string {
  const roots = scope.roots.map((root) => `${root}/`).join(", ");
  return (
    `"${target}" is outside this session's scope. The user locked this ` +
    `conversation to ${roots} — ${name} may only touch paths under ` +
    `${scope.roots.length === 1 ? "that prefix" : "those prefixes"}. ` +
    "A file with this name also exists there; use that one. If the work " +
    "truly needs this path, stop and ask the user to widen the scope."
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
