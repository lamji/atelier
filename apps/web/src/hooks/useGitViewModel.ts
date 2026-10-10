import { useCallback, useEffect, useRef, useState } from "react";
import type { GitRepo } from "@atelier/protocol";
import { bridge } from "@/services/bridge-client";
import { errorText } from "@/lib/error-text";
import { alert } from "@/state/alerts.store";
import { useConnectionStore } from "@/state/connection.store";
import { useGitStore } from "@/state/git.store";
import { useWorkspaceStore } from "@/state/workspace.store";
import { gitDraftModel } from "@/views/git/GitModelSelect";

/**
 * How often the remote refs are refreshed in the background.
 *
 * Three minutes: often enough that "in sync" means something, rare enough
 * that a laptop on a phone hotspot is not paying for it. A fetch of an
 * unchanged remote is a few hundred bytes.
 */
const AUTO_FETCH_MS = 180_000;

/**
 * ViewModel for the Git panel. Fetches status/log/branches when connected
 * and refetches whenever a git.state.changed event bumps stateVersion.
 */
export function useGitViewModel() {
  const connected = useConnectionStore((s) => s.state === "connected");
  // The shell stays mounted while editing/using the CLI. The live branch
  // badge and CLI changes rail have their own event-driven data sources.
  const panelVisible = useWorkspaceStore((s) => s.activityView === "git");
  const enabled = connected && panelVisible;
  // Per-field selectors: `live` (branch/dirty count) moves with every git
  // event, and the panel's data does not need to re-render for it.
  const status = useGitStore((s) => s.status);
  const commits = useGitStore((s) => s.commits);
  const branches = useGitStore((s) => s.branches);
  const stateVersion = useGitStore((s) => panelVisible ? s.stateVersion : 0);
  const gitDiff = useGitStore((s) => s.gitDiff);
  const error = useGitStore((s) => s.error);

  // The checkouts in this workspace. A folder that only groups a company's
  // projects has no repo of its own, so the panel shows one tab per project
  // instead of failing on a repository that was never there.
  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [activeRepo, setActiveRepo] = useState<string | null>(null);
  /** When the remote refs were last refreshed, for the branch row's label. */
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  /** A fetch in flight; a slow network must not stack them up. */
  const fetching = useRef(false);
  /** Whether the last background fetch failed, so one alert covers an outage. */
  const failed = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void bridge
      .rpc("git.repos", {})
      .then(({ repos: found, active }) => {
        if (cancelled) return;
        setRepos(found);
        setActiveRepo(active);
        // Published, so the Requests pane can drop another repo's data the
        // instant the panel moves rather than a fetch later.
        useGitStore.getState().setActiveRepo(active);
      })
      .catch(() => {
        if (!cancelled) setRepos([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, stateVersion]);

  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled, stateVersion]);

  /**
   * Keeps the remote refs current, so History and "in sync" are facts.
   *
   * Nothing in the panel used to contact the remote unless the user pressed
   * Fetch. History reads the local .git and the `origin/...` chips are
   * files written by the LAST fetch, so a branch could sit there saying "in
   * sync" for a day while the remote moved — the panel was showing a
   * photograph and captioning it as a live view.
   *
   * A fetch is safe to run unattended: it writes only remote-tracking refs,
   * never the working tree or the current branch. It is skipped while a git
   * operation is in flight, and it is quiet BY OUTCOME rather than by
   * policy — an alert only when refs actually moved, because a background
   * refresh announcing "nothing changed" every few minutes is noise, and
   * one that silently fails is the failure this app takes most seriously.
   */
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const sync = () => {
      if (document.visibilityState !== "visible") return;
      if (fetching.current) return;
      fetching.current = true;
      void bridge
        .rpc("git.fetch", {})
        .then((counts) => {
          if (cancelled) return;
          failed.current = false;
          setFetchedAt(Date.now());
          const moved = counts.updated ?? 0;
          if (moved > 0) {
            alert.info(
              `Fetched ${moved} ref${moved === 1 ? "" : "s"}`,
              counts.behind > 0
                ? `${counts.behind} commit(s) behind origin`
                : undefined
            );
          }
          useGitStore.getState().bumpStateVersion();
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          // Once per outage, not once per attempt: a machine offline for an
          // hour must not produce twenty identical alerts.
          if (!failed.current) {
            failed.current = true;
            alert.warning("Background fetch failed", shortErr(err));
          }
        })
        .finally(() => {
          fetching.current = false;
        });
    };

    sync();
    const timer = window.setInterval(sync, AUTO_FETCH_MS);
    const onFocus = () => sync();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [enabled, activeRepo]);

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
    // Before the RPC, not after: the switch is decided here, and every
    // pane keyed on it should stop showing the old checkout immediately.
    useGitStore.getState().setActiveRepo(repo);
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

  /**
   * Commits, amending the branch's own commit when there is exactly one.
   *
   * The branch is meant to read as ONE dated changelog entry rather than a
   * trail of fixups, so a second commit on the same branch rewrites the
   * first instead of stacking on it. Only ever at `ahead === 1`: at zero
   * there is nothing to amend, and past one an amend would fold together
   * commits the user chose to keep apart.
   */
  const commit = useCallback(
    async (message: string) => {
      const state = await bridge
        .rpc("git.branchState", {})
        .then((r) => r.state)
        .catch(() => null);
      const amend = Boolean(state && state.ahead === 1 && !state.onBase);
      await reportGit(
        () => bridge.rpc("git.commit", { message, amend }),
        (r) => [
          amend ? "Commit updated" : "Committed",
          `${r.hash.slice(0, 7)} · ${firstLine(message)}` +
            (amend && state?.hasUpstream
              ? " · already pushed — push with force to update the remote"
              : ""),
        ],
        amend ? "Could not update the commit" : "Commit failed"
      );
    },
    [reportGit]
  );

  /**
   * Branches the agent may not edit on.
   *
   * A workspace setting, so it is read and written through settings.* like
   * every other one — no per-repo store to keep in step, and the same list
   * applies to every checkout in the folder.
   */
  const [protectedBranches, setProtectedBranches] = useState<string[]>([]);
  const [protecting, setProtecting] = useState(false);
  /**
   * Every branch name this checkout knows, local and remote-tracking.
   *
   * Remote ones matter: `main` is usually the branch you most want
   * protected and the one you are least often standing on, so a list of
   * local branches alone would not offer it.
   */
  const [knownBranches, setKnownBranches] = useState<string[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void bridge
      .rpc("git.refs", {})
      .then(({ refs }) => {
        if (cancelled) return;
        const names = [
          ...refs.local.map((b) => b.name),
          ...refs.remote.map((r) => r.branch),
        ];
        setKnownBranches([...new Set(names.filter(Boolean))]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled, stateVersion]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void bridge
      .rpc("settings.get", {})
      .then((res) => {
        if (!cancelled) setProtectedBranches(res.settings.protectedBranches);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const saveProtected = useCallback(
    async (next: string[], done: [string, string?]) => {
      setProtecting(true);
      // Optimistic: the list is the user's own typing, and a failed save
      // reports itself. Waiting on a round trip to show a chip they just
      // added reads as the click not registering.
      const previous = protectedBranches;
      setProtectedBranches(next);
      try {
        const res = await bridge.rpc("settings.save", {
          settings: { protectedBranches: next },
        });
        setProtectedBranches(res.settings.protectedBranches);
        alert.success(done[0], done[1]);
      } catch (err) {
        setProtectedBranches(previous);
        alert.danger("Could not update protected branches", shortErr(err));
      } finally {
        setProtecting(false);
      }
    },
    [protectedBranches]
  );

  /**
   * The rule the CURRENT branch falls foul of, or null.
   *
   * The panel needs this as much as the agent does: a protection that stops
   * the agent committing to main while the app's own Commit button happily
   * does it is not a protection, it is a note about who is trusted.
   */
  const protectionOnBranch = useCallback(
    (branch: string): string | null =>
      protectedBranches.find((pattern) => branchMatches(branch, pattern)) ??
      null,
    [protectedBranches]
  );

  const protectBranch = useCallback(
    (pattern: string) =>
      saveProtected([...protectedBranches, pattern], [
        `Protected ${pattern}`,
        "The agent can no longer change files on it",
      ]),
    [protectedBranches, saveProtected]
  );

  const unprotectBranch = useCallback(
    (pattern: string) =>
      saveProtected(
        protectedBranches.filter((b) => b !== pattern),
        [`Removed protection for ${pattern}`]
      ),
    [protectedBranches, saveProtected]
  );

  /** What the commit box shows about amend-vs-new before you press it. */
  const branchState = useCallback(
    () =>
      bridge
        .rpc("git.branchState", {})
        .then((r) => r.state)
        .catch(() => null),
    []
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
      () =>
        bridge.rpc("git.generateCommitMessage", { model: gitDraftModel() }),
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
    fetchedAt,
    protectedBranches,
    protectionOnBranch,
    knownBranches,
    protecting,
    protectBranch,
    unprotectBranch,
    selectRepo,
    refresh,
    initRepo,
    stage,
    unstage,
    discard,
    commit,
    branchState,
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

/**
 * Mirror of the agent's matcher (hooks/protected-branch-guard.ts).
 *
 * Duplicated deliberately rather than round-tripped: the panel has to
 * decide whether to disable a button on every render, and asking the agent
 * for that would make the answer arrive after the click.
 */
export function branchMatches(branch: string, pattern: string): boolean {
  const name = branch.trim().toLowerCase();
  const rule = pattern.trim().toLowerCase();
  if (!name || !rule) return false;
  if (rule === name) return true;
  if (!rule.includes("*")) return false;
  const escaped = rule
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${escaped}$`).test(name);
}
