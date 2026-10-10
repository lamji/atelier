import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  GitBlameLine,
  GitCommit,
  GitCommitFile,
  GitRefs,
} from "@atelier/protocol";
import { bridge } from "@/services/bridge-client";
import { errorText } from "@/lib/error-text";
import { layoutGraph } from "@/lib/commit-graph";
import { useConnectionStore } from "@/state/connection.store";
import { useGitStore } from "@/state/git.store";

/** Commits per page of the graph; "Load more" adds another page. */
const PAGE = 200;

export type HistoryScope = "all" | "head" | "branch";
export type FileMode = "diff" | "blame" | "history";

/** A file opened from a commit, in the centre of the History view. */
export interface OpenFile {
  hash: string;
  file: GitCommitFile;
  mode: FileMode;
}

/** A value that is being fetched: absent, loading, loaded or failed. */
export interface Load<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

const IDLE = { data: null, loading: false, error: null };

/**
 * One async value keyed by a request string. A newer key abandons the
 * older request, so a quick run of clicks never shows a stale answer.
 */
function useLoad<T>(
  key: string | null,
  run: () => Promise<T>
): Load<T> {
  const [state, setState] = useState<Load<T>>(IDLE);
  useEffect(() => {
    if (!key) {
      setState(IDLE);
      return;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    run()
      .then((data) => {
        if (live) setState({ data, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (live) setState({ data: null, loading: false, error: errorText(err) });
      });
    return () => {
      live = false;
    };
    // `run` is rebuilt every render; the key is what identifies a request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

/**
 * ViewModel for the GitKraken-style History pane: the graph log across
 * every ref, the selected commit's files, and the file open in the centre
 * as a diff, a blame or its own history.
 */
export function useHistoryViewModel() {
  const connected = useConnectionStore((s) => s.state === "connected");
  const stateVersion = useGitStore((s) => s.stateVersion);
  const activeRepo = useGitStore((s) => s.activeRepo);

  const [scope, setScopeState] = useState<HistoryScope>("all");
  const [branchRef, setBranchRef] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);

  // A different checkout is a different history: nothing carries over.
  useEffect(() => {
    setSelected(null);
    setOpenFile(null);
    setLimit(PAGE);
    setScopeState("all");
    setBranchRef(null);
    setCommits([]);
  }, [activeRepo]);

  const refs = useLoad<GitRefs>(
    connected ? `${activeRepo}|${stateVersion}` : null,
    async () => (await bridge.rpc("git.refs", {})).refs
  );

  const setScope = useCallback((next: HistoryScope) => {
    setScopeState(next);
    if (next !== "branch") setBranchRef(null);
    setLimit(PAGE);
    setSelected(null);
    setOpenFile(null);
    setCommits([]);
  }, []);

  const selectBranch = useCallback((ref: string) => {
    setBranchRef(ref);
    setScopeState("branch");
    setLimit(PAGE);
    setSelected(null);
    setOpenFile(null);
    setCommits([]);
  }, []);

  // A ref can disappear after fetch/delete. Return to the full graph rather
  // than leaving a removed branch selected with an old commit list.
  useEffect(() => {
    if (!refs.data || scope !== "branch" || !branchRef) return;
    const names = [
      ...refs.data.local.map((item) => `refs/heads/${item.name}`),
      ...refs.data.remote.filter((item) => item.remote).map((item) => `refs/remotes/${item.ref}`),
    ];
    if (!names.includes(branchRef)) setScope("all");
  }, [branchRef, refs.data, scope, setScope]);

  const logKey = connected
    ? `${activeRepo}|${scope}|${branchRef ?? ""}|${limit}|${stateVersion}`
    : null;
  const log = useLoad(logKey, async () => {
    const res = await bridge.rpc("git.log", {
      maxCount: limit,
      all: scope === "all",
      ref: scope === "branch" ? branchRef ?? undefined : undefined,
    });
    return res.commits;
  });

  // Keep the last good log on screen while a refresh is in flight.
  useEffect(() => {
    if (log.data) setCommits(log.data);
  }, [log.data]);

  const graph = useMemo(() => layoutGraph(commits), [commits]);
  const selectedCommit = useMemo(
    () => commits.find((c) => c.hash === selected) ?? null,
    [commits, selected]
  );

  const files = useLoad(
    selected ? `${selected}|${stateVersion}` : null,
    () => bridge.rpc("git.commitFiles", { hash: selected! })
  );

  const fileKey = openFile
    ? `${openFile.hash}|${openFile.file.path}|${openFile.mode}`
    : null;

  const diff = useLoad(
    openFile?.mode === "diff" ? fileKey : null,
    () =>
      bridge.rpc("git.commitFileDiff", {
        hash: openFile!.hash,
        path: openFile!.file.path,
        oldPath: openFile!.file.oldPath,
      })
  );

  const blame = useLoad<GitBlameLine[]>(
    openFile?.mode === "blame" ? fileKey : null,
    async () => {
      // A deleted file has nothing at the commit; blame the parent's copy.
      const deleted = openFile!.file.status === "D";
      const res = await bridge.rpc("git.blame", {
        path: deleted ? (openFile!.file.oldPath ?? openFile!.file.path) : openFile!.file.path,
        ref: deleted ? `${openFile!.hash}^` : openFile!.hash,
      });
      return res.lines;
    }
  );

  const fileHistory = useLoad<GitCommit[]>(
    openFile?.mode === "history" ? fileKey : null,
    async () => {
      const res = await bridge.rpc("git.log", {
        maxCount: 300,
        path: openFile!.file.path,
      });
      return res.commits;
    }
  );

  const select = useCallback((hash: string | null) => {
    setSelected(hash);
  }, []);

  /** Moves the selection one row up or down the graph. */
  const step = useCallback(
    (delta: number) => {
      if (commits.length === 0) return;
      const idx = commits.findIndex((c) => c.hash === selected);
      const next = Math.min(
        commits.length - 1,
        Math.max(0, idx < 0 ? 0 : idx + delta)
      );
      setSelected(commits[next]!.hash);
    },
    [commits, selected]
  );

  const openFileAt = useCallback(
    (hash: string, file: GitCommitFile, mode?: FileMode) => {
      setOpenFile((prev) => ({ hash, file, mode: mode ?? prev?.mode ?? "diff" }));
    },
    []
  );

  const setMode = useCallback((mode: FileMode) => {
    setOpenFile((prev) => (prev ? { ...prev, mode } : prev));
  }, []);

  const closeFile = useCallback(() => setOpenFile(null), []);

  const loadMore = useCallback(() => setLimit((n) => n + PAGE), []);
  const refresh = useCallback(() => {
    useGitStore.getState().bumpStateVersion();
  }, []);

  return {
    scope,
    setScope,
    branchRef,
    selectBranch,
    refs,
    commits,
    graph,
    loadingLog: log.loading,
    logError: log.error,
    canLoadMore: commits.length >= limit,
    loadMore,
    refresh,
    selected,
    selectedCommit,
    select,
    step,
    files,
    openFile,
    openFileAt,
    setMode,
    closeFile,
    diff,
    blame,
    fileHistory,
  };
}

export type HistoryViewModel = ReturnType<typeof useHistoryViewModel>;
