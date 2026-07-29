import fs from "node:fs";
import path from "node:path";
import { toPosix } from "@atelier/shared";
import type { Db } from "../../storage/db.js";
import type { WorkspaceProfile } from "../profile/types.js";
import { parseMentions } from "./mentions.js";

/** Anchors kept per conversation — enough to re-focus, not a full history. */
const MAX_ANCHORS = 40;

export interface SessionScope {
  /** Locked project directories, workspace-relative posix. Empty = whole
   *  workspace, which is the correct answer for a single-project folder. */
  roots: string[];
  /** Files this conversation has already read or edited, newest first. */
  anchors: string[];
  /** How the current roots were decided. */
  source: "mention" | "explicit" | "inherited" | "none";
  /** True when this turn's mentions changed the lock. */
  changed: boolean;
}

export const EMPTY_SCOPE: SessionScope = {
  roots: [],
  anchors: [],
  source: "none",
  changed: false,
};

interface ScopeRow {
  roots: string;
  anchors: string;
}

/**
 * Per-conversation working-set lock.
 *
 * Mentioning a folder is the strongest scope signal a user can give, and
 * it used to survive only as characters in the prompt: retrieval ranked
 * across every checkout in the workspace, so three near-identical
 * badge.tsx files scored the same and the agent read all three. The lock
 * turns that signal into a filter, and makes it STICKY — a follow-up like
 * "add bg to each badge" carries no path at all, so without persistence
 * the second turn is unscoped again.
 *
 * Precedence: an explicit mention this turn always wins and re-locks;
 * otherwise the stored lock is inherited unchanged.
 */
export class SessionScopeStore {
  constructor(
    private db: Db,
    private workspaceRoot: string
  ) {}

  /**
   * Decides the scope for a turn and persists it. `profile` maps a
   * mentioned path onto the project that owns it, so mentioning a file
   * deep inside a checkout locks the checkout, not the file's folder.
   */
  resolve(
    conversationId: string,
    prompt: string,
    profile: WorkspaceProfile
  ): SessionScope {
    const stored = this.read(conversationId);
    const mentions = parseMentions(prompt, this.workspaceRoot);

    const mentionedRoots = new Set<string>();
    const mentionedFiles: string[] = [];
    for (const mention of mentions) {
      const owner = projectFor(mention.path, profile);
      if (owner) mentionedRoots.add(owner);
      if (!mention.isDir) mentionedFiles.push(mention.path);
    }

    // A mention that resolves to no project (single-project workspace, or
    // a path at the root) is a real mention but not a lock: there is no
    // narrower world to lock to, and locking to "src" would be wrong.
    if (mentionedRoots.size > 0) {
      const roots = [...mentionedRoots].sort();
      const changed = !sameRoots(roots, stored?.roots ?? []);
      const anchors = capAnchors([...mentionedFiles, ...(stored?.anchors ?? [])]);
      this.write(conversationId, roots, anchors);
      return { roots, anchors, source: "mention", changed };
    }

    if (!stored) {
      if (mentionedFiles.length === 0) return EMPTY_SCOPE;
      const anchors = capAnchors(mentionedFiles);
      this.write(conversationId, [], anchors);
      return { roots: [], anchors, source: "none", changed: false };
    }

    const anchors = capAnchors([...mentionedFiles, ...stored.anchors]);
    if (mentionedFiles.length > 0) {
      this.write(conversationId, stored.roots, anchors);
    }
    return {
      roots: stored.roots,
      anchors,
      source: stored.roots.length > 0 ? "inherited" : "none",
      changed: false,
    };
  }

  /**
   * Locks a conversation to roots the CALLER already knows, without a
   * mention to parse.
   *
   * Some tasks are born inside one project and nowhere else: the git
   * wizard's fix agent is dispatched about a specific checkout, and asking
   * it to infer that from a prompt full of command output is how it ended
   * up reading every repo's .git/config in the workspace. The lock is
   * persisted like any other, so the follow-up turns of that fix
   * conversation inherit it.
   *
   * Roots that are not real directories in the workspace are dropped — a
   * lock on a path that does not exist would filter retrieval down to
   * nothing.
   */
  lock(conversationId: string, requested: string[]): SessionScope {
    const stored = this.read(conversationId);
    const roots = [
      ...new Set(
        requested
          .map((root) => toPosix(root).replace(/^\.\/|\/+$/g, ""))
          .filter((root) => root !== "" && root !== "." && this.isDir(root))
      ),
    ].sort();
    if (roots.length === 0) {
      // Nothing to narrow to — a repo AT the workspace root is already the
      // whole world, and that is the correct unlocked answer.
      return stored
        ? { ...EMPTY_SCOPE, anchors: stored.anchors }
        : EMPTY_SCOPE;
    }
    const anchors = capAnchors(stored?.anchors ?? []);
    const changed = !sameRoots(roots, stored?.roots ?? []);
    this.write(conversationId, roots, anchors);
    return { roots, anchors, source: "explicit", changed };
  }

  /** Records a file the agent actually touched, so follow-ups anchor to it. */
  noteTouched(conversationId: string, relPath: string): void {
    const rel = toPosix(relPath);
    if (!rel) return;
    const stored = this.read(conversationId);
    const anchors = capAnchors([rel, ...(stored?.anchors ?? [])]);
    this.write(conversationId, stored?.roots ?? [], anchors);
  }

  get(conversationId: string): SessionScope {
    const stored = this.read(conversationId);
    if (!stored) return EMPTY_SCOPE;
    return {
      roots: stored.roots,
      anchors: stored.anchors,
      source: stored.roots.length > 0 ? "inherited" : "none",
      changed: false,
    };
  }

  clear(conversationId: string): void {
    this.db
      .prepare("DELETE FROM conversation_scope WHERE conversation_id = ?")
      .run(conversationId);
  }

  /** Guards `lock` against roots that do not exist on disk. */
  private isDir(root: string): boolean {
    try {
      return fs.statSync(path.resolve(this.workspaceRoot, root)).isDirectory();
    } catch {
      return false;
    }
  }

  private read(
    conversationId: string
  ): { roots: string[]; anchors: string[] } | null {
    const row = this.db
      .prepare(
        "SELECT roots, anchors FROM conversation_scope WHERE conversation_id = ?"
      )
      .get(conversationId) as ScopeRow | undefined;
    if (!row) return null;
    return {
      roots: parseList(row.roots),
      anchors: parseList(row.anchors),
    };
  }

  private write(
    conversationId: string,
    roots: string[],
    anchors: string[]
  ): void {
    this.db
      .prepare(
        "INSERT INTO conversation_scope" +
          "(conversation_id, roots, anchors, updated_at) VALUES(?, ?, ?, ?) " +
          "ON CONFLICT(conversation_id) DO UPDATE SET " +
          "roots = excluded.roots, anchors = excluded.anchors, " +
          "updated_at = excluded.updated_at"
      )
      .run(
        conversationId,
        JSON.stringify(roots),
        JSON.stringify(anchors),
        Date.now()
      );
  }
}

/**
 * Glob restricting retrieval to the lock — single root only.
 *
 * The retriever's glob matcher supports `*`, `**` and `?` and escapes
 * everything else, so a brace alternation would compile to a regex
 * matching the literal text "{a,b}/" and quietly return nothing at all.
 * A lock on two folders therefore returns undefined here and is enforced
 * by filtering results with `inScope`, which is exact for any number of
 * roots. Silently retrieving zero chunks is far worse than retrieving
 * wide and filtering.
 */
export function scopeGlob(scope: SessionScope): string | undefined {
  const only = scope.roots.length === 1 ? scope.roots[0] : undefined;
  return only ? `${only}/**` : undefined;
}

/** True when a workspace-relative path lies inside the lock. */
export function inScope(scope: SessionScope, relPath: string): boolean {
  if (scope.roots.length === 0) return true;
  const rel = toPosix(relPath);
  return scope.roots.some(
    (root) => rel === root || rel.startsWith(`${root}/`)
  );
}

/** The project directory that owns a path, longest match first. */
function projectFor(
  relPath: string,
  profile: WorkspaceProfile
): string | null {
  const rel = toPosix(relPath);
  const candidates = profile.projects
    .map((project) => project.path)
    .filter((projectPath) => projectPath !== "")
    .sort((a, b) => b.length - a.length);

  for (const candidate of candidates) {
    if (rel === candidate || rel.startsWith(`${candidate}/`)) return candidate;
  }
  return null;
}

function capAnchors(paths: string[]): string[] {
  const seen: string[] = [];
  for (const candidate of paths) {
    const rel = toPosix(candidate);
    if (!rel || seen.includes(rel)) continue;
    seen.push(rel);
    if (seen.length >= MAX_ANCHORS) break;
  }
  return seen;
}

function sameRoots(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((root, i) => root === b[i]);
}

function parseList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

/** Absolute path for a locked root, for callers that need a real cwd. */
export function scopeRootAbs(
  workspaceRoot: string,
  scope: SessionScope
): string | null {
  const only = scope.roots.length === 1 ? scope.roots[0] : undefined;
  return only ? path.resolve(workspaceRoot, only) : null;
}
