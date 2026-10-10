import path from "node:path";
import { toPosix } from "@atelier/shared";
import type { Db } from "../../storage/db.js";
import type { WorkspaceProfile } from "../profile/types.js";
import { parseMentions, parseTypedPaths } from "./mentions.js";

/** Anchors kept per conversation — enough to re-focus, not a full history. */
const MAX_ANCHORS = 40;

export interface SessionScope {
  /**
   * Locked project directories. ALWAYS EMPTY since 2026-08-29: project
   * locking was removed (see the store's doc). The field stays so every
   * consumer — the tool guard, retrieval clamp, git focus, prompt block,
   * UI chip — keeps its existing "no lock" path instead of a rewrite.
   */
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
 * Per-conversation working set — anchors and this turn's named paths.
 *
 * This used to be a LOCK as well: mentioning a folder pinned the
 * conversation to that project's roots, the pin persisted, and the tool
 * guard refused paths outside it. It was built for one hazard (three
 * near-identical badge.tsx files across checkouts) and it kept locking
 * the wrong thing: a feature match relocked sessions to foreign
 * checkouts, a `/context` trace of one folder was inherited by an
 * unrelated design request three turns later, and the model then reported
 * "package.json is outside this session's scope" as its blocker. A sticky
 * guess about which project the user means is worse than no guess.
 *
 * So roots are gone. `resolve`, `lock`, `focusFiles` and `get` return
 * `roots: []` unconditionally and persist only anchors; a stored row from
 * before this change has its roots ignored. What remains is the useful
 * half: which files this conversation has touched, and which the user
 * named in this message — hints to the ranker and the prompt, never a
 * boundary. Mentions outside the workspace are still granted as reads.
 */
export class SessionScopeStore {
  constructor(
    private db: Db,
    private workspaceRoot: string,
    /** Grants reads for "@" mentions that land outside the workspace. */
    private guard?: { allowRead(absPath: string): boolean }
  ) {}

  /**
   * Decides the working set for a turn and persists its anchors. Mentions
   * become anchors and this turn's `named` subject; nothing is locked.
   */
  resolve(
    conversationId: string,
    prompt: string,
    _profile: WorkspaceProfile
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

    const mentionedFiles: string[] = [];
    for (const mention of mentions) {
      // A path outside the workspace becomes a readable reference and
      // nothing more: the retrieval anchors assume workspace-relative
      // paths.
      if (mention.outside) {
        this.guard?.allowRead(mention.path);
        continue;
      }
      if (!mention.isDir) mentionedFiles.push(mention.path);
    }

    // Everything this message points at, however it was written.
    const named = capAnchors([...mentionedFiles, ...allowed]);

    if (!stored) {
      if (named.length === 0) return EMPTY_SCOPE;
      const anchors = capAnchors(mentionedFiles);
      this.write(conversationId, anchors);
      return { roots: [], anchors, allowed, named, source: "none", changed: false };
    }

    const anchors = capAnchors([...mentionedFiles, ...stored.anchors]);
    if (mentionedFiles.length > 0) this.write(conversationId, anchors);
    return {
      roots: [],
      anchors,
      allowed,
      named,
      source: mentionedFiles.length > 0 ? "mention" : "none",
      changed: false,
    };
  }

  /**
   * A caller that already knows its project (the git wizard's fix agent is
   * dispatched about one checkout). It used to lock the conversation to
   * that root; now it is a no-op on the store — the caller's checkout is
   * still routed through git focus by the task options, and the working
   * set is whatever the conversation has anchored.
   */
  lock(conversationId: string, _requested: string[]): SessionScope {
    const stored = this.read(conversationId);
    return stored ? { ...EMPTY_SCOPE, anchors: stored.anchors } : EMPTY_SCOPE;
  }

  /**
   * Anchors a conversation to the owner files of a product feature match
   * or a `/context` binding, so plain-language follow-ups like "fix the
   * dashboard spacing too" keep pointing at the same files. Anchors only:
   * a feature match is a guess made from this turn's wording, and a guess
   * once relocked whole sessions to the wrong checkout for good.
   */
  focusFiles(
    conversationId: string,
    featureFiles: string[],
    _profile: WorkspaceProfile,
    _opts: { explicit?: boolean } = {}
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
      return stored ? { ...EMPTY_SCOPE, anchors: stored.anchors } : EMPTY_SCOPE;
    }
    const anchors = capAnchors([...files, ...(stored?.anchors ?? [])]);
    this.write(conversationId, anchors);
    return {
      roots: [],
      anchors,
      allowed: [],
      named: [],
      source: "feature",
      changed: false,
    };
  }

  /** Records a file the agent actually touched, so follow-ups anchor to it. */
  noteTouched(conversationId: string, relPath: string): void {
    const rel = toPosix(relPath);
    if (!rel) return;
    const stored = this.read(conversationId);
    this.write(conversationId, capAnchors([rel, ...(stored?.anchors ?? [])]));
  }

  get(conversationId: string): SessionScope {
    const stored = this.read(conversationId);
    if (!stored) return EMPTY_SCOPE;
    return { ...EMPTY_SCOPE, anchors: stored.anchors };
  }

  clear(conversationId: string): void {
    this.db
      .prepare("DELETE FROM conversation_scope WHERE conversation_id = ?")
      .run(conversationId);
  }

  /**
   * Anchors only. The `roots` column still exists in the schema and is
   * written as `[]`; whatever a pre-2026-08-29 row holds there is ignored,
   * which is how a conversation locked under the old code is released.
   */
  private read(conversationId: string): { anchors: string[] } | null {
    const row = this.db
      .prepare(
        "SELECT anchors FROM conversation_scope WHERE conversation_id = ?"
      )
      .get(conversationId) as Pick<ScopeRow, "anchors"> | undefined;
    if (!row) return null;
    return { anchors: parseList(row.anchors) };
  }

  private write(conversationId: string, anchors: string[]): void {
    this.db
      .prepare(
        "INSERT INTO conversation_scope" +
          "(conversation_id, roots, anchors, updated_at) VALUES(?, ?, ?, ?) " +
          "ON CONFLICT(conversation_id) DO UPDATE SET " +
          "roots = excluded.roots, anchors = excluded.anchors, " +
          "updated_at = excluded.updated_at"
      )
      .run(conversationId, "[]", JSON.stringify(anchors), Date.now());
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

/**
 * The feature-match files a conversation may actually be focused onto.
 *
 * The feature table covers the whole workspace, so in a folder holding
 * several checkouts one ordinary word — "report", "preview", "auth" — can
 * tie features across unrelated projects. Unioning their files then locked
 * the session to two projects at once, neither of them the one the user was
 * working in: the run that produced this guard permitted `agenttest/my-app/`
 * and `ai-doc-forge/` while every error under discussion was in a third
 * checkout, and the model correctly reported the lock itself as the blocker.
 *
 * Rules, in order (roots are always empty now, so the first is history):
 *  - a locked conversation keeps its lock; only files inside it may focus,
 *  - otherwise a conversation may focus on ONE project — the one its own
 *    anchors already point at,
 *  - when the match spans several and the conversation's own anchors do not
 *    say which, nothing focuses. An unlocked turn is the status quo; a lock
 *    on the wrong project is a dead end the user has to notice and undo.
 */
export function featureFocusFiles(
  files: string[],
  profile: WorkspaceProfile,
  scope: SessionScope
): string[] {
  const candidates = files.map((file) => toPosix(file)).filter(Boolean);
  if (candidates.length === 0) return [];

  if (scope.roots.length > 0) {
    return candidates.filter((file) =>
      scope.roots.some((root) => file === root || file.startsWith(`${root}/`))
    );
  }

  const byProject = new Map<string, string[]>();
  for (const file of candidates) {
    const owner = projectFor(file, profile);
    // A file no project claims cannot pull the session anywhere, so it
    // never decides the question — it rides along with whatever does.
    if (!owner) continue;
    byProject.set(owner, [...(byProject.get(owner) ?? []), file]);
  }
  if (byProject.size <= 1) return candidates;

  const anchored = new Map<string, number>();
  for (const anchor of scope.anchors) {
    const owner = projectFor(anchor, profile);
    if (!owner || !byProject.has(owner)) continue;
    anchored.set(owner, (anchored.get(owner) ?? 0) + 1);
  }
  const best = [...anchored.entries()].sort((a, b) => b[1] - a[1]);
  const winner = best[0];
  // A tie between two projects the conversation has touched equally is
  // still no answer, and picking one by sort order would be a coin toss
  // with a persisted lock as the prize.
  if (!winner || (best[1] && best[1][1] === winner[1])) return [];
  return byProject.get(winner[0]) ?? [];
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
