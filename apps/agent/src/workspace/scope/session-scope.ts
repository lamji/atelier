import fs from "node:fs";
import path from "node:path";
import { toPosix } from "@atelier/shared";
import type { Db } from "../../storage/db.js";
import type { WorkspaceProfile } from "../profile/types.js";
import { parseMentions, parseTypedPaths } from "./mentions.js";

/** Anchors kept per conversation — enough to re-focus, not a full history. */
const MAX_ANCHORS = 40;

export interface SessionScope {
  /** Locked project directories, workspace-relative posix. Empty = whole
   *  workspace, which is the correct answer for a single-project folder. */
  roots: string[];
  /** Files this conversation has already read or edited, newest first. */
  anchors: string[];
  /**
   * Paths named in THIS turn that the lock would otherwise refuse. Pointing
   * at a file is the clearest instruction a user can give, and it has to
   * beat a lock inherited from an earlier turn — the alternative is the
   * agent refusing to open the file the request is about. Per-turn and never
   * persisted: it grants exactly what was named, and does not widen the lock.
   */
  allowed: string[];
  /**
   * Files this turn's own text points at — "@" mentions and typed paths
   * alike. The subject of THIS message, as opposed to `anchors`, which is
   * everything the conversation has ever touched. When this is non-empty
   * the anchors stop being the working set and become mere history: the
   * file the user just named outranks the file the agent happened to edit
   * three turns ago.
   */
  named: string[];
  /** How the current roots were decided. */
  source: "mention" | "explicit" | "feature" | "inherited" | "none";
  /** True when this turn's mentions changed the lock. */
  changed: boolean;
}

export const EMPTY_SCOPE: SessionScope = {
  roots: [],
  anchors: [],
  allowed: [],
  named: [],
  source: "none",
  changed: false,
};

/**
 * Atelier's own notes. They are never part of a project and so never inside
 * a lock, which meant a locked conversation could not read — let alone
 * update — the note that was driving it. The app writes its task reports
 * here itself; refusing the model the same folder was never a safety
 * property, only a way to strand the note-driven flow.
 */
const ALWAYS_IN_SCOPE = ".atelier/";

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
    private workspaceRoot: string,
    /** Grants reads for "@" mentions that land outside the workspace. */
    private guard?: { allowRead(absPath: string): boolean }
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
    // Typed without an "@": a reference grant for this turn, not a lock.
    // Absolute entries stay out of workspace scope and only register the
    // exact external path as readable.
    const typedPaths = parseTypedPaths(prompt, this.workspaceRoot);
    const allowed = typedPaths.filter((candidate) => !path.isAbsolute(candidate));
    for (const candidate of typedPaths) {
      if (path.isAbsolute(candidate)) this.guard?.allowRead(candidate);
    }

    const mentionedRoots = new Set<string>();
    const mentionedFiles: string[] = [];
    /** Mentioned directories the profile does not know as projects. */
    const unownedDirs: string[] = [];
    for (const mention of mentions) {
      // A path outside the workspace becomes a readable reference and
      // nothing more: it is not a project, so it must never join the lock
      // (which routes git and the directory map) or the retrieval anchors,
      // both of which assume workspace-relative paths.
      if (mention.outside) {
        this.guard?.allowRead(mention.path);
        continue;
      }
      const owner = projectFor(mention.path, profile);
      if (owner) mentionedRoots.add(owner);
      else if (mention.isDir) unownedDirs.push(mention.path);
      if (!mention.isDir) mentionedFiles.push(mention.path);
    }

    // Everything this message points at, however it was written. Typed
    // paths and "@" mentions differ in what they LOCK; they do not differ
    // in what the turn is about.
    const named = capAnchors([...mentionedFiles, ...allowed]);

    // A mention that resolves to no project (single-project workspace, or
    // a path at the root) is a real mention but not a lock: there is no
    // narrower world to lock to, and locking to "src" would be wrong.
    if (mentionedRoots.size > 0) {
      // ...but once a lock IS being built, every folder named in the same
      // breath has to be inside it. Detection is not perfect — a folder
      // with no manifest of its own is not a "project" — and a mentioned
      // folder falling outside the lock its own siblings created is the
      // worst outcome available: the agent refuses to read what it was
      // just pointed at.
      for (const dir of unownedDirs) {
        const covered = [...mentionedRoots].some(
          (root) => dir === root || dir.startsWith(`${root}/`)
        );
        if (!covered) mentionedRoots.add(dir);
      }
      const roots = [...mentionedRoots].sort();
      const changed = !sameRoots(roots, stored?.roots ?? []);
      const anchors = capAnchors([...mentionedFiles, ...(stored?.anchors ?? [])]);
      this.write(conversationId, roots, anchors);
      return { roots, anchors, allowed, named, source: "mention", changed };
    }

    if (!stored) {
      if (named.length === 0) return EMPTY_SCOPE;
      const anchors = capAnchors(mentionedFiles);
      this.write(conversationId, [], anchors);
      return { roots: [], anchors, allowed, named, source: "none", changed: false };
    }

    const anchors = capAnchors([...mentionedFiles, ...stored.anchors]);
    if (mentionedFiles.length > 0) {
      this.write(conversationId, stored.roots, anchors);
    }
    return {
      roots: stored.roots,
      anchors,
      allowed,
      named,
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
    return { roots, anchors, allowed: [], named: [], source: "explicit", changed };
  }

  /**
   * Narrows a conversation from a product feature match, not a typed path.
   *
   * Plain-language follow-ups like "fix the dashboard spacing too" do not
   * mention a file, but the feature model knows the owner files. Persisting
   * those files as anchors keeps the session on the same feature; resolving
   * their owning projects gives the tool guard a hard boundary when possible.
   */
  focusFiles(
    conversationId: string,
    featureFiles: string[],
    profile: WorkspaceProfile
  ): SessionScope {
    const stored = this.read(conversationId);
    const files = [
      ...new Set(
        featureFiles
          .map((file) => toPosix(file).replace(/^\.\/|\/+$/g, ""))
          .filter(Boolean)
      ),
    ];
    if (files.length === 0) {
      return stored
        ? {
            roots: stored.roots,
            anchors: stored.anchors,
            allowed: [],
            named: [],
            source: stored.roots.length > 0 ? "inherited" : "none",
            changed: false,
          }
        : EMPTY_SCOPE;
    }

    const mentionedRoots = new Set<string>();
    for (const file of files) {
      const owner = projectFor(file, profile);
      if (owner) mentionedRoots.add(owner);
    }
    const roots =
      mentionedRoots.size > 0
        ? [...mentionedRoots].sort()
        : (stored?.roots ?? []);
    const anchors = capAnchors([...files, ...(stored?.anchors ?? [])]);
    const changed = !sameRoots(roots, stored?.roots ?? []);
    this.write(conversationId, roots, anchors);
    return { roots, anchors, allowed: [], named: [], source: "feature", changed };
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
      // A read of the stored lock, with no prompt to read grants out of.
      allowed: [],
      named: [],
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

/** Anchors inherited by a turn that produced no evidence of its own. */
const RECENT_FALLBACK = 4;

/**
 * The files THIS turn is actually about, drawn out of everything the
 * conversation has ever touched.
 *
 * `anchors` is append-only and newest-first, and that is the whole problem:
 * one edit to the wrong file puts it at the top of the list, from where it
 * is fed to the ranker as a target and printed to the model as "files this
 * conversation is already working on" for the rest of the session. A single
 * mistake compounds into every later turn, which is exactly the drift users
 * report as "it keeps touching the wrong file" and "where is that context
 * coming from".
 *
 * So membership expires unless the turn re-earns it. An anchor stays when
 * the user named it, or when this turn's own retrieval independently
 * surfaced it — evidence from now, not a receipt from earlier. Recency is
 * the fallback only for a turn that produced no evidence at all (nothing
 * named, nothing retrieved), which is the genuine "keep going" follow-up
 * the anchors exist for; even then it is a short tail, not the whole list.
 *
 * A turn that retrieved real files but confirmed no anchor gets an EMPTY
 * working set on purpose. Those files are already in the retrieved-context
 * block; repeating stale history beside them is what the model mistook for
 * direction.
 */
export function workingSet(
  scope: SessionScope,
  retrievedPaths: Iterable<string>,
  max = 12
): string[] {
  const retrieved = new Set<string>();
  for (const path of retrievedPaths) retrieved.add(toPosix(path));

  const confirmed = scope.anchors.filter((anchor) =>
    retrieved.has(toPosix(anchor))
  );
  const noEvidence =
    scope.named.length === 0 && confirmed.length === 0 && retrieved.size === 0;
  const ordered = noEvidence
    ? scope.anchors.slice(0, RECENT_FALLBACK)
    : [...scope.named, ...confirmed];

  const seen: string[] = [];
  for (const path of ordered) {
    if (!path || seen.includes(path)) continue;
    seen.push(path);
    if (seen.length >= max) break;
  }
  return seen;
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
  if (rel.startsWith(ALWAYS_IN_SCOPE)) return true;
  if (scope.allowed.includes(rel)) return true;
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
