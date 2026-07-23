import { useCallback, useEffect } from "react";
import { bridge } from "@/services/bridge-client";
import { useConnectionStore } from "@/state/connection.store";
import { useGitStore } from "@/state/git.store";
import { useWorkspaceStore } from "@/state/workspace.store";

/** ViewModel for the file explorer: tree loading, expand, open file. */
export function useFileExplorerViewModel() {
  const connected = useConnectionStore((s) => s.state === "connected");
  const { tree, treeVersion, expanded, selectedPath } = useWorkspaceStore();

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void bridge
      .rpc("fs.tree", { depth: 6 })
      .then(({ root }) => {
        if (!cancelled) useWorkspaceStore.getState().setTree(root);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
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
