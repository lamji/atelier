import { useCallback, useEffect, useState } from "react";
import type { GitRepo } from "@atelier/protocol";
import { bridge } from "@/services/bridge-client";
import { errorText } from "@/lib/error-text";
import { alert } from "@/state/alerts.store";
import { useConnectionStore } from "@/state/connection.store";
import { useGitStore } from "@/state/git.store";
import { useWorkspaceStore } from "@/state/workspace.store";

/**
 * ViewModel for the Git panel. Fetches status/log/branches when connected
 * and refetches whenever a git.state.changed event bumps stateVersion.
 */
export function useGitViewModel() {
  const connected = useConnectionStore((s) => s.state === "connected");
  // Per-field selectors: `live` (branch/dirty count) moves with every git
  // event, and the panel's data does not need to re-render for it.
  const status = useGitStore((s) => s.status);
  const commits = useGitStore((s) => s.commits);
  const branches = useGitStore((s) => s.branches);
  const stateVersion = useGitStore((s) => s.stateVersion);
  const gitDiff = useGitStore((s) => s.gitDiff);
  const error = useGitStore((s) => s.error);

  // The checkouts in this workspace. A folder that only groups a company's
  // projects has no repo of its own, so the panel shows one tab per project
  // instead of failing on a repository that was never there.
  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [activeRepo, setActiveRepo] = useState<string | null>(null);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void bridge
      .rpc("git.repos", {})
      .then(({ repos: found, active }) => {
        if (cancelled) return;
        setRepos(found);
        setActiveRepo(active);
      })
      .catch(() => {
        if (!cancelled) setRepos([]);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, stateVersion]);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void Promise.all([
      bridge.rpc("git.status", {}),
      bridge.rpc("git.log", { maxCount: 30 }),
      bridge.rpc("git.branches", {}),
    ])
      .then(([s, l, b]) => {
        if (cancelled) return;
        useGitStore.getState().setData(s.status, l.commits, b.branches);
      })
      .catch((err: unknown) => {
        // errorText, not String(): the bridge rejects with a plain object,
        // which stringifies to "[object Object]".
        if (!cancelled) useGitStore.getState().setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [connected, stateVersion]);

  /**
   * Every git operation reports its outcome as an alert — success and
   * failure — so an action fired from a panel the user has already left
   * still surfaces. Errors are re-thrown for the caller's inline message.
   */
  const reportGit = useCallback(
    async <T,>(
      run: () => Promise<T>,
      done: (result: T) => [string, string?] | null,
      failTitle: string
    ): Promise<T> => {
      try {
        const result = await run();
        const msg = done(result);
        if (msg) alert.success(msg[0], msg[1]);
        return result;
      } catch (err) {
        alert.danger(failTitle, shortErr(err));
        throw err;
      }
    },
    []
  );

  const selectRepo = useCallback(async (repo: string) => {
    await bridge.rpc("git.selectRepo", { repo });
    alert.info(`Git panel now on ${repo}`);
    // Clears the stale "not a git repository" state so switching from an
    // unselected workspace lands on data, not the previous error.
    useGitStore.getState().setError(null);
    useGitStore.getState().bumpStateVersion();
  }, []);

  const refresh = useCallback(() => {
    useGitStore.getState().bumpStateVersion();
  }, []);

  /**
   * Create the repository this workspace does not have. Clearing the error
   * is what takes the panel off its empty state — the refetch that follows
   * lands on a real repo.
   */
  const initRepo = useCallback(async () => {
    const { root } = await reportGit(
      () => bridge.rpc("git.init", {}),
      (r) => ["Repository initialized", r.root === "." ? undefined : r.root],
      "Could not initialize repository"
    );
    void root;
    useGitStore.getState().setError(null);
    useGitStore.getState().bumpStateVersion();
  }, [reportGit]);

  const stage = useCallback(
    async (paths: string[]) => {
      await reportGit(
        () => bridge.rpc("git.stage", { paths }),
        () => [`Staged ${describe(paths)}`],
        "Stage failed"
      );
    },
    [reportGit]
  );

  const unstage = useCallback(
    async (paths: string[]) => {
      await reportGit(
        () => bridge.rpc("git.unstage", { paths }),
        () => [`Unstaged ${describe(paths)}`],
        "Unstage failed"
      );
    },
    [reportGit]
  );

  const discard = useCallback(
    async (paths: string[]) => {
      await reportGit(
        () => bridge.rpc("git.discard", { paths }),
        () => [`Discarded changes in ${describe(paths)}`],
        "Discard failed"
      );
    },
    [reportGit]
  );

  const commit = useCallback(
    async (message: string) => {
      await reportGit(
        () => bridge.rpc("git.commit", { message }),
        (r) => ["Committed", `${r.hash.slice(0, 7)} · ${firstLine(message)}`],
        "Commit failed"
      );
    },
    [reportGit]
  );

  const checkout = useCallback(
    async (ref: string) => {
      await reportGit(
        () => bridge.rpc("git.checkout", { ref }),
        () => [`Switched to ${ref}`],
        `Could not switch to ${ref}`
      );
    },
    [reportGit]
  );

  /**
   * Creates a private GitHub repo via the agent (gh CLI) and sets it as
   * origin, then refetches so the panel swaps off the no-remote state.
   */
  const connectGitHub = useCallback(async () => {
    await reportGit(
      () => bridge.rpc("git.connectRemote", {}),
      (r) => ["Connected to GitHub", r.url],
      "Could not connect to GitHub"
    );
    useGitStore.getState().bumpStateVersion();
  }, [reportGit]);

  /**
   * Asks the agent to draft a commit message from the current changes
   * (Claude Haiku). The caller puts it in the editable commit box.
   */
  const generateCommitMessage = useCallback(async () => {
    const result = await reportGit(
      () => bridge.rpc("git.generateCommitMessage", {}),
      () => ["Commit message drafted", "review it before committing"],
      "Could not draft a commit message"
    );
    return result.message;
  }, [reportGit]);

  /**
   * Loads a single-file diff. The pending path is published first so the
   * diff surface can open immediately and show a spinner — a click that
   * appears to do nothing for a second reads as a broken button.
   */
  const openDiff = useCallback(async (path: string, staged: boolean) => {
    useGitStore.getState().setGitDiffLoading(path);
    try {
      const result = await bridge.rpc("git.diff", { path, staged });
      // The user may have closed it, or clicked another file, meanwhile.
      if (useGitStore.getState().gitDiffLoading !== path) return;
      useGitStore.getState().setGitDiff({
        path,
        staged,
        before: result.before ?? "",
        after: result.after ?? "",
      });
      useWorkspaceStore.getState().setRightTab("editor");
    } catch (err) {
      useGitStore.getState().setGitDiffLoading(null);
      alert.danger(`Could not open the diff of ${path}`, shortErr(err));
    }
  }, []);

  const closeDiff = useCallback(() => {
    useGitStore.getState().setGitDiffLoading(null);
    useGitStore.getState().setGitDiff(null);
  }, []);

  return {
    status,
    commits,
    branches,
    gitDiff,
    error,
    repos,
    activeRepo,
    selectRepo,
    refresh,
    initRepo,
    stage,
    unstage,
    discard,
    commit,
    checkout,
    connectGitHub,
    generateCommitMessage,
    openDiff,
    closeDiff,
  };
}

export type GitViewModel = ReturnType<typeof useGitViewModel>;

function describe(paths: string[]): string {
  if (paths.length === 1) return paths[0] ?? "1 file";
  return `${paths.length} files`;
}

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").trim().slice(0, 72);
}

function shortErr(err: unknown): string {
  return errorText(err).replace(/^Error:\s*/, "").slice(0, 160);
}
