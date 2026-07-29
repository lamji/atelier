import { execFile, type ExecFileException } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { simpleGit, type SimpleGit } from "simple-git";
import type {
  GitBranch,
  GitCommit,
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
}

const REFRESH_DEBOUNCE_MS = 400;

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
    const [s, remotes] = await Promise.all([git.status(), git.getRemotes()]);
    return {
      branch: s.current ?? "HEAD",
      hasRemote: remotes.length > 0,
      ahead: s.ahead,
      behind: s.behind,
      // Repo-relative on the way out would be ambiguous across checkouts,
      // and these paths come straight back to us in stage/unstage/diff.
      files: s.files.map((f) => ({
        path: this.toWorkspaceRel(root, f.path),
        index: f.index.trim(),
        workingDir: f.working_dir.trim(),
      })),
      isClean: s.isClean(),
    };
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
      const s = await this.clientFor(this.activeRoot).status();
      const snapshot: GitSnapshot = {
        branch: s.current ?? "HEAD",
        isClean: s.isClean(),
        changedFiles: s.files.length,
      };
      // Key includes per-file index/workingDir so stage/unstage moves —
      // which keep the same file count — still register as changes.
      const stateKey = [
        snapshot.branch,
        s.ahead,
        s.behind,
        ...s.files.map((f) => `${f.path}:${f.index}${f.working_dir}`),
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
