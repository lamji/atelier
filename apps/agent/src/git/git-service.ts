import { execFile, type ExecFileException } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { simpleGit, type SimpleGit } from "simple-git";
import type {
  GitBranch,
  GitCommit,
  GitLineStat,
  GitMergeState,
  GitRepo,
  GitStatus,
} from "@atelier/protocol";
import { debounce, toPosix } from "@atelier/shared";
import type { EventBus } from "../events/event-bus.js";
import {
  findRepoRoot,
  listRepoRoots,
  repoActivityAt,
  repoLabel,
} from "./repo-locator.js";

/** A resolved checkout: the client plus its absolute root. */
interface ResolvedRepo {
  git: SimpleGit;
  root: string;
}

export interface GitDiffResult {
  diff: string;
  before?: string;
  after?: string;
}

interface GitSnapshot {
  branch: string;
  isClean: boolean;
  changedFiles: number;
  conflicts: number;
  mergeKind: GitMergeState["kind"] | null;
}

/**
 * The .git entries whose presence means an operation is mid-flight. Watched
 * alongside HEAD/index/refs so a `git pull` run from a terminal — not from
 * Atelier — still flips the UI into merge mode the moment it conflicts.
 */
const MERGE_STATE_FILES = [
  "MERGE_HEAD",
  "MERGE_MSG",
  "REBASE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
];

const REFRESH_DEBOUNCE_MS = 400;

/**
 * How many changed files get a content mark per refresh. One `stat` each,
 * so a working tree with thousands of changes stays bounded; past the cap
 * the file count and status marks still carry the change.
 */
const MAX_CONTENT_MARKED_FILES = 200;

/**
 * Untracked files have no diff to count, so their "added" lines are read
 * off disk. Bounded twice — how many files, and how big each may be —
 * because a fresh checkout can list thousands of them and a status call
 * must not turn into a full-tree read.
 */
const MAX_UNTRACKED_COUNTED = 200;
const MAX_UNTRACKED_BYTES = 512 * 1024;

/**
 * simple-git wrapper. Emits git.state.changed whenever the observable repo
 * state (branch / clean / changed-file count) actually changes — triggered
 * by our own mutations, workspace file edits, and a small watcher on
 * .git/HEAD + index + refs that catches external CLI commits/checkouts.
 *
 * Multi-repo by construction. The opened folder is frequently NOT the
 * repository — it holds several checkouts side by side — and binding
 * every operation to the workspace root made git unusable there: `git
 * status` failed with "the workspace is not a git repository" while the
 * file being edited sat inside a perfectly good checkout one level down.
 * Every call now routes to the checkout that owns the path it touches,
 * and paths cross this boundary workspace-relative in both directions so
 * callers never have to know which repo answered.
 */
export class GitService {
  private clients = new Map<string, SimpleGit>();
  /** The checkout UI-driven calls act on when they name no path. */
  private activeRoot: string | null = null;
  private lastStateKey: string | null = null;
  private gitDirWatcher: FSWatcher | null = null;
  private refreshing = false;
  private refreshQueued = false;

  /** Debounced entry point for high-frequency triggers (file watcher). */
  readonly scheduleRefresh: () => void;

  constructor(
    private workspaceRoot: string,
    private bus: EventBus
  ) {
    this.scheduleRefresh = debounce(() => void this.refresh(), REFRESH_DEBOUNCE_MS);
  }

  /**
   * Absolute path of the active checkout — the cwd for spawned git/gh
   * commands. Falls back to the workspace root so callers that spawn a
   * CLI still get a valid directory when no repo has been resolved.
   */
  get root(): string {
    return this.activeRoot ?? this.workspaceRoot;
  }

  /** Workspace-relative label of the active checkout, for UI and errors. */
  get activeRepo(): string | null {
    return this.activeRoot ? repoLabel(this.workspaceRoot, this.activeRoot) : null;
  }

  /** Detects the active repo and starts the .git metadata watcher. */
  async start(): Promise<void> {
    const initial = this.detectInitialRoot();
    if (initial) await this.bindActive(initial);
  }

  /**
   * Every checkout in the workspace, with the details the git panel needs
   * to render one tab each.
   *
   * A company folder that groups several project repos has no repository
   * of its own, and there is no correct single answer to "the" repo — so
   * the UI is handed the list instead of an error. Branch and change count
   * are read per repo; the scan is depth-limited and this is called on
   * panel open, not per render.
   */
  async repos(): Promise<GitRepo[]> {
    const roots = listRepoRoots(this.workspaceRoot);
    return Promise.all(roots.map((root) => this.describeRepo(root)));
  }

  /**
   * Turn the workspace root into a git repository.
   *
   * Only ever creates one at the workspace root, and only when nothing is
   * there yet: an existing checkout (or one nested inside) is a repo the
   * user already has, and a second `git init` over it would shadow it.
   * Binds the new repo as active so the panel fills in without a reopen.
   */
  async init(): Promise<{ root: string }> {
    const existing = findRepoRoot(this.workspaceRoot, ".");
    if (existing) {
      await this.bindActive(existing);
      return { root: repoLabel(this.workspaceRoot, existing) };
    }
    await this.clientFor(this.workspaceRoot).init();
    await this.bindActive(this.workspaceRoot);
    // The panel reads its state from the event, same as any other mutation.
    await this.refresh();
    return { root: repoLabel(this.workspaceRoot, this.workspaceRoot) };
  }

  private async describeRepo(root: string): Promise<GitRepo> {
    const label = repoLabel(this.workspaceRoot, root);
    const base = {
      path: label,
      name: path.basename(root),
      active: root === this.activeRoot,
    };
    try {
      const status = await this.clientFor(root).status();
      return {
        ...base,
        branch: status.current ?? "HEAD",
        changedFiles: status.files.length,
      };
    } catch {
      // A repo mid-operation (or with no commits) still gets a tab.
      return { ...base, branch: null, changedFiles: 0 };
    }
  }

  /**
   * Selects the checkout the panel and unqualified commands act on.
   * Returns its workspace-relative label so the caller can confirm.
   */
  async select(repo: string): Promise<string> {
    const resolved = findRepoRoot(this.workspaceRoot, repo);
    if (!resolved) throw new Error(this.noRepoMessage(repo));
    if (resolved !== this.activeRoot) {
      await this.bindActive(resolved);
      await this.refresh();
    }
    return repoLabel(this.workspaceRoot, resolved);
  }

  /**
   * Points UI-driven git at the checkout owning `relPath`, and reports
   * whether that moved. The session scope calls this when a task starts,
   * so the git panel follows the folder the user locked onto instead of
   * showing an unrelated repo's branch.
   */
  async focus(relPath: string): Promise<boolean> {
    const resolved = findRepoRoot(this.workspaceRoot, relPath);
    if (!resolved || resolved === this.activeRoot) return false;
    await this.bindActive(resolved);
    await this.refresh();
    return true;
  }

  /**
   * Picks the checkout a call acts on.
   *
   * `repo` is the caller's explicit choice and is never second-guessed: if
   * it does not resolve, that is an error, because silently running
   * against a different repository than the one named is the exact class
   * of bug this routing exists to end. `pathHint` is inferred from a path
   * the call already carries, so it may fall back to the active checkout.
   */
  private resolveRepo(repo?: string, pathHint?: string): ResolvedRepo {
    if (repo !== undefined) {
      const named = findRepoRoot(this.workspaceRoot, repo);
      if (!named) throw new Error(this.noRepoMessage(repo));
      return { git: this.clientFor(named), root: named };
    }
    const root = pathHint
      ? (findRepoRoot(this.workspaceRoot, pathHint) ?? this.activeRoot)
      : this.activeRoot;

    if (!root) throw new Error(this.noRepoMessage(pathHint));
    return { git: this.clientFor(root), root };
  }

  private clientFor(root: string): SimpleGit {
    let client = this.clients.get(root);
    if (!client) {
      client = simpleGit({ baseDir: root });
      this.clients.set(root, client);
    }
    return client;
  }

  /**
   * The checkout to start on.
   *
   * A container folder has no repo of its own, so one of its projects has
   * to be picked or the panel opens on an error. The most recently worked
   * in wins — it is the one you were last committing to, and it beats an
   * alphabetical guess. This is a starting point, not a commitment: the
   * session scope re-points it the moment a folder is mentioned, and the
   * panel names the selection at all times.
   */
  private detectInitialRoot(): string | null {
    const own = findRepoRoot(this.workspaceRoot, ".");
    if (own) return own;

    const found = listRepoRoots(this.workspaceRoot);
    if (found.length <= 1) return found[0] ?? null;
    return found.reduce((best, candidate) =>
      repoActivityAt(candidate) > repoActivityAt(best) ? candidate : best
    );
  }

  private async bindActive(root: string): Promise<void> {
    this.activeRoot = root;
    this.lastStateKey = null;
    await this.gitDirWatcher?.close();

    const gitDir = path.join(root, ".git");
    this.gitDirWatcher = chokidar.watch(
      [
        path.join(gitDir, "HEAD"),
        path.join(gitDir, "index"),
        path.join(gitDir, "refs"),
        ...MERGE_STATE_FILES.map((name) => path.join(gitDir, name)),
      ],
      { ignoreInitial: true, depth: 3 }
    );
    this.gitDirWatcher.on("all", () => this.scheduleRefresh());
  }

  private noRepoMessage(hint?: string): string {
    const candidates = listRepoRoots(this.workspaceRoot).map((root) =>
      repoLabel(this.workspaceRoot, root)
    );
    const where = hint ? `"${toPosix(hint)}" is not inside a git repository` : "";
    if (candidates.length === 0) {
      return (
        `${where || "The workspace is not a git repository"} and no ` +
        "repository exists anywhere inside this workspace."
      );
    }
    return (
      `${where || "The workspace root is not a git repository"}. ` +
      "This workspace holds separate checkouts — pass the `repo` argument " +
      `(or a path inside one) to say which: ${candidates.join(", ")}.`
    );
  }

  /** Workspace-relative path -> path relative to the repo that owns it. */
  private toRepoRel(root: string, relPath: string): string {
    const abs = path.resolve(this.workspaceRoot, relPath);
    return toPosix(path.relative(root, abs));
  }

  /** Repo-relative path -> workspace-relative, the wire contract. */
  private toWorkspaceRel(root: string, repoRel: string): string {
    const abs = path.resolve(root, repoRel);
    return toPosix(path.relative(this.workspaceRoot, abs));
  }

  stop(): void {
    void this.gitDirWatcher?.close();
    this.gitDirWatcher = null;
  }

  async status(repo?: string): Promise<GitStatus> {
    const { git, root } = this.resolveRepo(repo);
    const [s, remotes, indexStats, workStats] = await Promise.all([
      git.status(),
      git.getRemotes(),
      this.numstat(root, true),
      this.numstat(root, false),
    ]);
    const branch = s.current ?? "HEAD";
    const untrackedStats = this.untrackedLineStats(root, s.files);
    return {
      branch,
      hasRemote: remotes.length > 0,
      ahead: s.ahead,
      behind: s.behind,
      conflicts: s.conflicted.map((p) => this.toWorkspaceRel(root, p)),
      mergeState: this.readMergeState(root, branch),
      // Repo-relative on the way out would be ambiguous across checkouts,
      // and these paths come straight back to us in stage/unstage/diff.
      files: s.files.map((f) => {
        const key = toPosix(f.path);
        const indexStat = indexStats.get(key);
        const workStat = untrackedStats.get(key) ?? workStats.get(key);
        return {
          path: this.toWorkspaceRel(root, f.path),
          index: f.index.trim(),
          workingDir: f.working_dir.trim(),
          ...(indexStat ? { indexStat } : {}),
          ...(workStat ? { workStat } : {}),
          // Cheap per-file "content moved" mark. The changes rail measures
          // a CLI session against it, so it must be read the same way for
          // every file — see contentMark.
          mark: this.contentMark(root, f.path),
        };
      }),
      isClean: s.isClean(),
    };
  }

  /**
   * Per-file added/removed counts, keyed by REPO-relative path.
   *
   * `-z` output because a path is not safe to split on: it can contain
   * spaces, quotes, or a rename arrow. Each record is
   * `added \t removed \t path NUL`, and a rename writes an empty path
   * followed by the old and new paths as their own NUL-terminated fields.
   */
  private async numstat(
    root: string,
    staged: boolean
  ): Promise<Map<string, GitLineStat>> {
    const out = new Map<string, GitLineStat>();
    let raw: string;
    try {
      raw = await this.clientFor(root).raw([
        "diff",
        "--numstat",
        "-z",
        ...(staged ? ["--cached"] : []),
      ]);
    } catch {
      // Unborn branch, or a repo mid-operation: no counts this round.
      return out;
    }
    const parts = raw.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const record = parts[i];
      if (!record) continue;
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(record);
      if (!match) continue;
      let path = match[3] ?? "";
      if (path === "") {
        // Rename/copy: the old and new paths are the next two fields.
        const oldPath = parts[++i] ?? "";
        const newPath = parts[++i] ?? "";
        path = newPath || oldPath;
      }
      if (!path) continue;
      const binary = match[1] === "-" || match[2] === "-";
      out.set(toPosix(path), {
        added: binary ? 0 : Number(match[1]),
        removed: binary ? 0 : Number(match[2]),
        ...(binary ? { binary: true } : {}),
      });
    }
    return out;
  }

  /**
   * Line counts for untracked files, which no diff reports: they are
   * entirely new, so every line is an addition. Bounded — see the
   * constants — because a fresh checkout can list thousands of them.
   */
  private untrackedLineStats(
    root: string,
    files: Array<{ index: string; path: string }>
  ): Map<string, GitLineStat> {
    const out = new Map<string, GitLineStat>();
    let seen = 0;
    for (const f of files) {
      if (f.index !== "?") continue;
      if (++seen > MAX_UNTRACKED_COUNTED) break;
      const stat = this.countNewFileLines(root, f.path);
      if (stat) out.set(toPosix(f.path), stat);
    }
    return out;
  }

  /** Line count of an untracked file, or a binary/too-big marker. */
  private countNewFileLines(
    root: string,
    repoRel: string
  ): GitLineStat | undefined {
    const abs = path.join(root, repoRel);
    try {
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) return undefined;
      if (stat.size > MAX_UNTRACKED_BYTES) {
        return { added: 0, removed: 0, binary: true };
      }
      const buffer = fs.readFileSync(abs);
      // Same test git uses to call a file binary: a NUL in the first 8k.
      if (buffer.subarray(0, 8000).includes(0)) {
        return { added: 0, removed: 0, binary: true };
      }
      if (buffer.length === 0) return { added: 0, removed: 0 };
      let lines = 0;
      for (const byte of buffer) if (byte === 10) lines++;
      // A final line without a trailing newline still counts.
      if (buffer[buffer.length - 1] !== 10) lines++;
      return { added: lines, removed: 0 };
    } catch {
      return undefined;
    }
  }

  async log(maxCount = 50, repo?: string): Promise<GitCommit[]> {
    const { git } = this.resolveRepo(repo);
    let result;
    try {
      result = await git.log({ maxCount });
    } catch (error) {
      // Unborn branch (no commits yet) — an empty history, not a failure.
      if (/does not have any commits/i.test(String(error))) return [];
      throw error;
    }
    return result.all.map((c) => ({
      hash: c.hash,
      message: c.message,
      author: c.author_name,
      date: c.date,
      refs: c.refs || undefined,
    }));
  }

  /**
   * Patch text for the repo, one file, or a ref comparison. When a single
   * path is requested, also returns full before/after contents so the UI
   * can render a side-by-side diff.
   */
  async diff(
    relPath?: string,
    staged?: boolean,
    ref?: string,
    repo?: string
  ): Promise<GitDiffResult> {
    // A named file routes on its own, so diffing one file never needs the
    // caller to also know which checkout it belongs to.
    const { git, root } = this.resolveRepo(repo, relPath);
    const args: string[] = [];
    if (staged) args.push("--cached");
    if (ref) args.push(ref);
    if (relPath) args.push("--", this.toRepoRel(root, relPath));

    const diff = await git.diff(args);
    if (!relPath) return { diff };

    const { before, after } = await this.fileVersions(
      root,
      relPath,
      staged ?? false
    );
    return { diff, before, after };
  }

  async stage(paths: string[], repo?: string): Promise<void> {
    const { git, root } = this.resolveRepo(repo, paths[0]);
    await git.add(paths.map((p) => this.toRepoRel(root, p)));
    await this.refresh();
  }

  async unstage(paths: string[], repo?: string): Promise<void> {
    const { git, root } = this.resolveRepo(repo, paths[0]);
    const repoPaths = paths.map((p) => this.toRepoRel(root, p));
    try {
      await git.raw(["restore", "--staged", "--", ...repoPaths]);
    } catch (error) {
      // Unborn branch: restore needs HEAD. Everything staged is newly
      // added there, so dropping it from the index is the same unstage.
      if (!/could not resolve 'HEAD'/i.test(String(error))) throw error;
      await git.raw(["rm", "--cached", "-r", "--", ...repoPaths]);
    }
    await this.refresh();
  }

  /**
   * Discards working-tree changes like VSCode: tracked files are restored
   * from the index, untracked files are deleted. Staged content is kept.
   */
  async discard(paths: string[], repo?: string): Promise<void> {
    const { git, root } = this.resolveRepo(repo, paths[0]);
    const s = await git.status();
    const untracked = new Set(
      s.files.filter((f) => f.index === "?").map((f) => toPosix(f.path))
    );
    const toRestore: string[] = [];
    for (const relPath of paths) {
      const repoRel = this.toRepoRel(root, relPath);
      if (untracked.has(repoRel)) {
        fs.rmSync(path.join(root, repoRel), { force: true });
      } else {
        toRestore.push(repoRel);
      }
    }
    if (toRestore.length > 0) {
      await git.raw(["restore", "--", ...toRestore]);
    }
    await this.refresh();
  }

  async commit(message: string, repo?: string): Promise<string> {
    const { git } = this.resolveRepo(repo);
    const result = await git.commit(message);
    await this.refresh();
    return result.commit;
  }

  /**
   * Creates a private GitHub repo named after the workspace folder via the
   * gh CLI and wires it up as `origin`. Pushes the current branch when
   * history exists (an unborn branch has nothing to push yet).
   */
  async connectToGitHub(repo?: string): Promise<string> {
    const { git, root } = this.resolveRepo(repo);
    const remotes = await git.getRemotes();
    if (remotes.length > 0) {
      throw new Error("A remote is already configured for this repository");
    }
    const name = path.basename(root);
    const args = [
      "repo",
      "create",
      name,
      "--source",
      root,
      "--private",
      "--remote",
      "origin",
    ];
    if (await this.hasCommits(repo)) args.push("--push");
    await this.execGh(args, name, root);
    const url = (await git.raw(["remote", "get-url", "origin"])).trim();
    await this.refresh();
    return url;
  }

  async branches(repo?: string): Promise<GitBranch[]> {
    const { git } = this.resolveRepo(repo);
    const result = await git.branchLocal();
    return result.all.map((name) => ({
      name,
      current: name === result.current,
    }));
  }

  async checkout(ref: string, create?: boolean, repo?: string): Promise<void> {
    const { git } = this.resolveRepo(repo);
    if (create) await git.checkoutLocalBranch(ref);
    else await git.checkout(ref);
    await this.refresh();
  }

  /**
   * Recomputes the repo snapshot and emits git.state.changed when it
   * differs from the last one. Serialized: a refresh arriving while one is
   * in flight runs once more after it finishes.
   */
  async refresh(): Promise<void> {
    if (!this.activeRoot) return;
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      const root = this.activeRoot;
      const s = await this.clientFor(root).status();
      const mergeState = this.readMergeState(root, s.current ?? "HEAD");
      const snapshot: GitSnapshot = {
        branch: s.current ?? "HEAD",
        isClean: s.isClean(),
        changedFiles: s.files.length,
        conflicts: s.conflicted.length,
        mergeKind: mergeState?.kind ?? null,
      };
      // Key includes per-file index/workingDir so stage/unstage moves —
      // which keep the same file count — still register as changes, and a
      // content mark so a WRITE to an already-dirty file does too. Without
      // the mark, every edit after the first to the same file was silent:
      // the marks stay " M", the count stays put, and nothing downstream
      // ever heard that the file had moved.
      const stateKey = [
        snapshot.branch,
        s.ahead,
        s.behind,
        s.files.length,
        snapshot.conflicts,
        snapshot.mergeKind ?? "",
        ...s.files
          .slice(0, MAX_CONTENT_MARKED_FILES)
          .map(
            (f) =>
              `${f.path}:${f.index}${f.working_dir}:` +
              this.contentMark(root, f.path)
          ),
      ].join("|");
      if (stateKey !== this.lastStateKey) {
        this.lastStateKey = stateKey;
        this.bus.publish("git.state.changed", snapshot);
      }
    } catch {
      // transient git failure (e.g. mid-operation lock) — next trigger retries
    } finally {
      this.refreshing = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }

  /**
   * What operation, if any, the checkout is in the middle of. Read straight
   * off .git — the same files the watcher listens to — so a conflict made
   * by any client (Atelier, a terminal, another IDE) reports the same way.
   *
   * Labels name the two sides the way the resolver shows them. For a
   * rebase git swaps the meaning: "ours" is the branch being rebased ONTO
   * and "theirs" is your own commit being replayed — the labels say so,
   * because a resolver that calls your own work "theirs" without warning
   * is how the wrong side gets kept.
   */
  private readMergeState(root: string, branch: string): GitMergeState | null {
    const gitDir = path.join(root, ".git");
    const exists = (name: string) => fs.existsSync(path.join(gitDir, name));
    const readTrim = (name: string): string => {
      try {
        return fs.readFileSync(path.join(gitDir, name), "utf8").trim();
      } catch {
        return "";
      }
    };
    if (exists("MERGE_HEAD")) {
      const message = readTrim("MERGE_MSG");
      // "Merge branch 'main' of <url>" is what a pull writes: the branch
      // came from the remote, so it is shown as origin/main rather than a
      // second "main" that reads as the branch we are already on.
      const pulled = message.match(/^Merge branch '([^']+)' of \S+/);
      const theirs =
        (pulled ? `origin/${pulled[1]}` : undefined) ??
        message.match(/^Merge (?:remote-tracking )?branch '([^']+)'/)?.[1] ??
        message.match(/^Merge (?:commit|tag) '([^']+)'/)?.[1] ??
        readTrim("MERGE_HEAD").slice(0, 7);
      return {
        kind: "merge",
        ours: branch,
        theirs,
        ...(message ? { message } : {}),
      };
    }
    if (exists("rebase-merge") || exists("rebase-apply")) {
      const dir = exists("rebase-merge") ? "rebase-merge" : "rebase-apply";
      const headName = readTrim(`${dir}/head-name`).replace(/^refs\/heads\//, "");
      const onto = readTrim(`${dir}/onto`).slice(0, 7);
      return {
        kind: "rebase",
        ours: onto ? `${onto} (rebasing onto)` : "upstream (rebasing onto)",
        theirs: `${headName || branch} (your commit)`,
      };
    }
    if (exists("CHERRY_PICK_HEAD")) {
      return {
        kind: "cherry-pick",
        ours: branch,
        theirs: `${readTrim("CHERRY_PICK_HEAD").slice(0, 7)} (cherry-pick)`,
      };
    }
    if (exists("REVERT_HEAD")) {
      return {
        kind: "revert",
        ours: branch,
        theirs: `revert of ${readTrim("REVERT_HEAD").slice(0, 7)}`,
      };
    }
    return null;
  }

  /**
   * One index stage of a path (:1: base, :2: ours, :3: theirs), or "" when
   * that side does not exist — added on one side only, deleted on the
   * other. Public so the conflict ops can build the resolver payload
   * without re-deriving repo routing.
   */
  async stageContent(
    relPath: string,
    stage: 1 | 2 | 3,
    repo?: string
  ): Promise<string> {
    const { root } = this.resolveRepo(repo, relPath);
    return this.showOrEmpty(root, `:${stage}:${this.toRepoRel(root, relPath)}`);
  }

  /** Repo-relative path for `relPath`, and the checkout root that owns it. */
  locate(relPath: string, repo?: string): { root: string; repoRel: string } {
    const { root } = this.resolveRepo(repo, relPath);
    return { root, repoRel: this.toRepoRel(root, relPath) };
  }

  /** Raw working-tree bytes of a workspace-relative path ("" if missing). */
  readWorking(relPath: string): string {
    return this.readWorkingFile(relPath);
  }

  /** Writes a workspace-relative path in place (the resolver's save). */
  writeWorking(relPath: string, content: string): void {
    const abs = path.join(this.workspaceRoot, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }

  /**
   * A cheap "has this file's content moved" mark: size and mtime.
   *
   * Not a hash — the question is only whether the last snapshot is stale,
   * and hashing every dirty file on a 400ms debounce would read the whole
   * working tree to answer it. A file being written as we look, or already
   * deleted, marks as absent and the next refresh settles it.
   */
  private contentMark(root: string, repoRel: string): string {
    try {
      const stat = fs.statSync(path.join(root, repoRel));
      return `${stat.size}@${Math.round(stat.mtimeMs)}`;
    } catch {
      return "-";
    }
  }

  /**
   * Full contents for the two sides of a single-file diff.
   * staged:   HEAD version  vs  index version
   * unstaged: index version (falling back to HEAD) vs working tree
   * Missing sides (untracked / newly added / deleted) resolve to "".
   */
  private async fileVersions(
    root: string,
    relPath: string,
    staged: boolean
  ): Promise<{ before: string; after: string }> {
    // git show specs are always repo-relative, never workspace-relative.
    const posix = this.toRepoRel(root, relPath);
    if (staged) {
      return {
        before: await this.showOrEmpty(root, `HEAD:${posix}`),
        after: await this.showOrEmpty(root, `:0:${posix}`),
      };
    }
    let before = await this.showOrEmpty(root, `:0:${posix}`);
    if (before === "") before = await this.showOrEmpty(root, `HEAD:${posix}`);
    return { before, after: this.readWorkingFile(relPath) };
  }

  private async showOrEmpty(root: string, spec: string): Promise<string> {
    try {
      return await this.clientFor(root).show([spec]);
    } catch {
      return "";
    }
  }

  private readWorkingFile(relPath: string): string {
    try {
      return fs.readFileSync(path.join(this.workspaceRoot, relPath), "utf8");
    } catch {
      return ""; // deleted from working tree
    }
  }

  /** True once the repo has at least one commit (HEAD resolves). */
  async hasCommits(repo?: string): Promise<boolean> {
    try {
      const { git } = this.resolveRepo(repo);
      await git.raw(["rev-parse", "--verify", "HEAD"]);
      return true;
    } catch {
      return false;
    }
  }

  /** Runs the gh CLI, translating common failures into friendly errors. */
  private execGh(
    args: string[],
    repoName: string,
    cwd: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(
        "gh",
        args,
        { cwd, windowsHide: true },
        (error, _stdout, stderr) => {
          if (!error) return resolve();
          reject(new Error(ghErrorMessage(error, String(stderr), repoName)));
        }
      );
    });
  }
}

function ghErrorMessage(
  error: ExecFileException,
  stderr: string,
  repoName: string
): string {
  if (error.code === "ENOENT") {
    return (
      "GitHub CLI (gh) is not installed. " +
      "Install it from https://cli.github.com and try again."
    );
  }
  if (/gh auth login|not logged in|authentication/i.test(stderr)) {
    return "GitHub CLI is not authenticated. Run `gh auth login` first.";
  }
  if (/already exists/i.test(stderr)) {
    return `A GitHub repository named "${repoName}" already exists.`;
  }
  return stderr.trim() || error.message;
}

// smoke-touch
