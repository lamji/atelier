import { execFile, type ExecFileException } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { simpleGit, type SimpleGit } from "simple-git";
import type { GitBranch, GitCommit, GitStatus } from "@atelier/protocol";
import { debounce, toPosix } from "@atelier/shared";
import type { EventBus } from "../events/event-bus.js";

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
 */
export class GitService {
  private git: SimpleGit;
  private isRepo = false;
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
    this.git = simpleGit({ baseDir: workspaceRoot });
    this.scheduleRefresh = debounce(() => void this.refresh(), REFRESH_DEBOUNCE_MS);
  }

  /** Absolute workspace path — cwd for spawned git/gh commands. */
  get root(): string {
    return this.workspaceRoot;
  }

  /** Detects repo state and starts the .git metadata watcher. */
  async start(): Promise<void> {
    this.isRepo = await this.git.checkIsRepo();
    if (!this.isRepo) return;

    const gitDir = path.join(this.workspaceRoot, ".git");
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

  stop(): void {
    void this.gitDirWatcher?.close();
    this.gitDirWatcher = null;
  }

  async status(): Promise<GitStatus> {
    this.assertRepo();
    const [s, remotes] = await Promise.all([
      this.git.status(),
      this.git.getRemotes(),
    ]);
    return {
      branch: s.current ?? "HEAD",
      hasRemote: remotes.length > 0,
      ahead: s.ahead,
      behind: s.behind,
      files: s.files.map((f) => ({
        path: toPosix(f.path),
        index: f.index.trim(),
        workingDir: f.working_dir.trim(),
      })),
      isClean: s.isClean(),
    };
  }

  async log(maxCount = 50): Promise<GitCommit[]> {
    this.assertRepo();
    let result;
    try {
      result = await this.git.log({ maxCount });
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
    ref?: string
  ): Promise<GitDiffResult> {
    this.assertRepo();
    const args: string[] = [];
    if (staged) args.push("--cached");
    if (ref) args.push(ref);
    if (relPath) args.push("--", relPath);

    const diff = await this.git.diff(args);
    if (!relPath) return { diff };

    const { before, after } = await this.fileVersions(relPath, staged ?? false);
    return { diff, before, after };
  }

  async stage(paths: string[]): Promise<void> {
    this.assertRepo();
    await this.git.add(paths);
    await this.refresh();
  }

  async unstage(paths: string[]): Promise<void> {
    this.assertRepo();
    try {
      await this.git.raw(["restore", "--staged", "--", ...paths]);
    } catch (error) {
      // Unborn branch: restore needs HEAD. Everything staged is newly
      // added there, so dropping it from the index is the same unstage.
      if (!/could not resolve 'HEAD'/i.test(String(error))) throw error;
      await this.git.raw(["rm", "--cached", "-r", "--", ...paths]);
    }
    await this.refresh();
  }

  /**
   * Discards working-tree changes like VSCode: tracked files are restored
   * from the index, untracked files are deleted. Staged content is kept.
   */
  async discard(paths: string[]): Promise<void> {
    this.assertRepo();
    const s = await this.git.status();
    const untracked = new Set(
      s.files.filter((f) => f.index === "?").map((f) => toPosix(f.path))
    );
    const toRestore: string[] = [];
    for (const relPath of paths) {
      if (untracked.has(toPosix(relPath))) {
        fs.rmSync(path.join(this.workspaceRoot, relPath), { force: true });
      } else {
        toRestore.push(relPath);
      }
    }
    if (toRestore.length > 0) {
      await this.git.raw(["restore", "--", ...toRestore]);
    }
    await this.refresh();
  }

  async commit(message: string): Promise<string> {
    this.assertRepo();
    const result = await this.git.commit(message);
    await this.refresh();
    return result.commit;
  }

  /**
   * Creates a private GitHub repo named after the workspace folder via the
   * gh CLI and wires it up as `origin`. Pushes the current branch when
   * history exists (an unborn branch has nothing to push yet).
   */
  async connectToGitHub(): Promise<string> {
    this.assertRepo();
    const remotes = await this.git.getRemotes();
    if (remotes.length > 0) {
      throw new Error("A remote is already configured for this repository");
    }
    const name = path.basename(this.workspaceRoot);
    const args = [
      "repo",
      "create",
      name,
      "--source",
      this.workspaceRoot,
      "--private",
      "--remote",
      "origin",
    ];
    if (await this.hasCommits()) args.push("--push");
    await this.execGh(args, name);
    const url = (await this.git.raw(["remote", "get-url", "origin"])).trim();
    await this.refresh();
    return url;
  }

  async branches(): Promise<GitBranch[]> {
    this.assertRepo();
    const result = await this.git.branchLocal();
    return result.all.map((name) => ({
      name,
      current: name === result.current,
    }));
  }

  async checkout(ref: string, create?: boolean): Promise<void> {
    this.assertRepo();
    if (create) await this.git.checkoutLocalBranch(ref);
    else await this.git.checkout(ref);
    await this.refresh();
  }

  /**
   * Recomputes the repo snapshot and emits git.state.changed when it
   * differs from the last one. Serialized: a refresh arriving while one is
   * in flight runs once more after it finishes.
   */
  async refresh(): Promise<void> {
    if (!this.isRepo) return;
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      const s = await this.git.status();
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
    relPath: string,
    staged: boolean
  ): Promise<{ before: string; after: string }> {
    const posix = toPosix(relPath);
    if (staged) {
      return {
        before: await this.showOrEmpty(`HEAD:${posix}`),
        after: await this.showOrEmpty(`:0:${posix}`),
      };
    }
    let before = await this.showOrEmpty(`:0:${posix}`);
    if (before === "") before = await this.showOrEmpty(`HEAD:${posix}`);
    return { before, after: this.readWorkingFile(relPath) };
  }

  private async showOrEmpty(spec: string): Promise<string> {
    try {
      return await this.git.show([spec]);
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
  async hasCommits(): Promise<boolean> {
    try {
      await this.git.raw(["rev-parse", "--verify", "HEAD"]);
      return true;
    } catch {
      return false;
    }
  }

  /** Runs the gh CLI, translating common failures into friendly errors. */
  private execGh(args: string[], repoName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(
        "gh",
        args,
        { cwd: this.workspaceRoot, windowsHide: true },
        (error, _stdout, stderr) => {
          if (!error) return resolve();
          reject(new Error(ghErrorMessage(error, String(stderr), repoName)));
        }
      );
    });
  }

  private assertRepo(): void {
    if (!this.isRepo) {
      throw new Error("The workspace is not a git repository");
    }
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
