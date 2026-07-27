import { useCallback, useEffect } from "react";
import { bridge } from "@/services/bridge-client";
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
        if (!cancelled) useGitStore.getState().setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [connected, stateVersion]);

  const refresh = useCallback(() => {
    useGitStore.getState().bumpStateVersion();
  }, []);

  const stage = useCallback(async (paths: string[]) => {
    await bridge.rpc("git.stage", { paths });
  }, []);

  const unstage = useCallback(async (paths: string[]) => {
    await bridge.rpc("git.unstage", { paths });
  }, []);

  const discard = useCallback(async (paths: string[]) => {
    await bridge.rpc("git.discard", { paths });
  }, []);

  const commit = useCallback(async (message: string) => {
    await bridge.rpc("git.commit", { message });
  }, []);

  const checkout = useCallback(async (ref: string) => {
    await bridge.rpc("git.checkout", { ref });
  }, []);

  /**
   * Creates a private GitHub repo via the agent (gh CLI) and sets it as
   * origin, then refetches so the panel swaps off the no-remote state.
   */
  const connectGitHub = useCallback(async () => {
    await bridge.rpc("git.connectRemote", {});
    useGitStore.getState().bumpStateVersion();
  }, []);

  /**
   * Asks the agent to draft a commit message from the current changes
   * (Claude Haiku). The caller puts it in the editable commit box.
   */
  const generateCommitMessage = useCallback(async () => {
    const result = await bridge.rpc("git.generateCommitMessage", {});
    return result.message;
  }, []);

  /** Loads a single-file diff and shows it in the editor pane. */
  const openDiff = useCallback(async (path: string, staged: boolean) => {
    const result = await bridge.rpc("git.diff", { path, staged });
    useGitStore.getState().setGitDiff({
      path,
      staged,
      before: result.before ?? "",
      after: result.after ?? "",
    });
    useWorkspaceStore.getState().setRightTab("editor");
  }, []);

  const closeDiff = useCallback(() => {
    useGitStore.getState().setGitDiff(null);
  }, []);

  return {
    status,
    commits,
    branches,
    gitDiff,
    error,
    refresh,
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
