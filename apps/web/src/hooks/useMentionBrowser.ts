import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "@/services/bridge-client";
import { useConnectionStore } from "@/state/connection.store";
import { useWorkspaceStore } from "@/state/workspace.store";
import { sortMentionEntries, type MentionEntry } from "@/lib/mention-tree";

/**
 * ViewModel for the composer's "@" file browser.
 *
 * Folders are listed on demand with `fs.list` — the same readdir the file
 * explorer uses — so what you see is the real directory, not a pre-walked
 * tree that stopped at a depth or node cap.
 *
 * Listings are cached per folder and tagged with the workspace version they
 * were read at, so a file change re-reads the open folder in place. The
 * cached rows stay on screen until the fresh ones land: dropping them would
 * flip an open menu back to "Reading folder…" every time the agent writes.
 */
export interface MentionBrowser {
  /** Cached children by folder path ("" = root); undefined until first read. */
  dirs: Record<string, MentionEntry[] | undefined>;
  /** Reads a folder if it is missing or older than the workspace version. */
  ensureDir: (dir: string) => void;
  /** Flat file list, used only for the cross-folder search fallback. */
  filePaths: string[];
}

export function useMentionBrowser(): MentionBrowser {
  const connected = useConnectionStore((s) => s.state === "connected");
  const treeVersion = useWorkspaceStore((s) => s.treeVersion);
  const [dirs, setDirs] = useState<Record<string, MentionEntry[]>>({});
  const [filePaths, setFilePaths] = useState<string[]>([]);
  /** Workspace version each cached folder was read at. */
  const readAt = useRef(new Map<string, number>());
  const inFlight = useRef(new Set<string>());
  /** Bumped on reconnect, where cached paths may be a different project. */
  const session = useRef(0);

  useEffect(() => {
    session.current += 1;
    readAt.current.clear();
    inFlight.current.clear();
    setDirs({});
    if (!connected) {
      setFilePaths([]);
      return;
    }
    let cancelled = false;
    void bridge
      .rpc("fs.files", {})
      .then(({ files }) => {
        if (!cancelled) setFilePaths(files);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connected]);

  const ensureDir = useCallback(
    (dir: string) => {
      if (!connected || inFlight.current.has(dir)) return;
      if (readAt.current.get(dir) === treeVersion) return;
      inFlight.current.add(dir);
      const mySession = session.current;
      const store = (entries: MentionEntry[]) => {
        inFlight.current.delete(dir);
        if (mySession !== session.current) return;
        readAt.current.set(dir, treeVersion);
        setDirs((prev) => ({ ...prev, [dir]: entries }));
      };
      void bridge
        .rpc("fs.list", { path: dir })
        .then(({ entries }) =>
          store(
            sortMentionEntries(
              entries.map((e) => ({
                path: e.path,
                name: e.name,
                isDir: e.type === "dir",
              }))
            )
          )
        )
        // An unreadable folder lists as empty rather than hanging on "loading".
        .catch(() => store([]));
    },
    [connected, treeVersion]
  );

  return { dirs, ensureDir, filePaths };
}
