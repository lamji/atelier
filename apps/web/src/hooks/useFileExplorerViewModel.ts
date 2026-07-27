import { useCallback, useEffect } from "react";
import { bridge } from "@/services/bridge-client";
import { useConnectionStore } from "@/state/connection.store";
import { useGitStore } from "@/state/git.store";
import { useWorkspaceStore } from "@/state/workspace.store";

/** A burst of agent writes should cost one tree read, not one per file. */
const TREE_REFETCH_DEBOUNCE_MS = 400;

/** ViewModel for the file explorer: tree loading, expand, open file. */
export function useFileExplorerViewModel() {
  const connected = useConnectionStore((s) => s.state === "connected");
  const tree = useWorkspaceStore((s) => s.tree);
  const treeVersion = useWorkspaceStore((s) => s.treeVersion);
  const expanded = useWorkspaceStore((s) => s.expanded);
  const selectedPath = useWorkspaceStore((s) => s.selectedPath);

  // Debounced by construction: a new treeVersion re-runs the effect, whose
  // cleanup cancels the pending read, so only the last one in a burst fires.
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void bridge
        .rpc("fs.tree", { depth: 6 })
        .then(({ root }) => {
          if (!cancelled) useWorkspaceStore.getState().setTree(root);
        })
        .catch(() => undefined);
    }, treeVersion === 0 ? 0 : TREE_REFETCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connected, treeVersion]);

  const openFile = useCallback(async (path: string) => {
    try {
      const file = await bridge.rpc("fs.readFile", { path });
      useGitStore.getState().setGitDiff(null); // git diff no longer covers editor
      useWorkspaceStore
        .getState()
        .setSelectedFile(file.path, file.content, file.mtime);
    } catch {
      // binary/oversized file — leave selection unchanged
    }
  }, []);

  const toggleDir = useCallback((path: string) => {
    useWorkspaceStore.getState().toggleExpanded(path);
  }, []);

  return { tree, expanded, selectedPath, openFile, toggleDir };
}
