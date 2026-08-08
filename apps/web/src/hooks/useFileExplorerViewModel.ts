import { useCallback, useEffect, useMemo, useState } from "react";
import { pathBasename, pathDirname } from "@atelier/shared";
import { bridge } from "@/services/bridge-client";
import { useConnectionStore } from "@/state/connection.store";
import { useGitStore } from "@/state/git.store";
import { useProjectsStore } from "@/state/projects.store";
import { useWorkspaceStore } from "@/state/workspace.store";

/** A burst of agent writes should cost one tree read, not one per file. */
const TREE_REFETCH_DEBOUNCE_MS = 400;

/** An in-progress "New File" / "New Folder" row, shown inside `parent`. */
export interface ExplorerDraft {
  parent: string;
  type: "file" | "dir";
}

/** A cut/copied path waiting for a paste, VS Code style. */
export interface ExplorerClipboard {
  path: string;
  mode: "copy" | "cut";
}

/** Joins workspace-relative POSIX segments; "" is the workspace root. */
function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/**
 * "app.ts" -> "app copy.ts", "app copy.ts" -> "app copy 2.ts". Extensions
 * are preserved because a duplicate of a .ts file is still a .ts file.
 */
function copyName(name: string, attempt: number): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const suffix = attempt === 1 ? " copy" : ` copy ${attempt}`;
  return `${stem}${suffix}${ext}`;
}

/** ViewModel for the file explorer: tree, expand/open, and authoring. */
export function useFileExplorerViewModel() {
  const connected = useConnectionStore((s) => s.state === "connected");
  const tree = useWorkspaceStore((s) => s.tree);
  const treeVersion = useWorkspaceStore((s) => s.treeVersion);
  const expanded = useWorkspaceStore((s) => s.expanded);
  const selectedPath = useWorkspaceStore((s) => s.selectedPath);
  const epoch = useWorkspaceStore((s) => s.workspaceEpoch);
  const projectPath = useProjectsStore((s) => s.active()?.path ?? "");

  const [draft, setDraft] = useState<ExplorerDraft | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<ExplorerClipboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The path the delete confirmation is asking about. */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

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

  // A different project must not inherit the old one's pending rename or a
  // clipboard entry pointing at a path that no longer exists.
  useEffect(() => {
    setDraft(null);
    setRenaming(null);
    setClipboard(null);
    setPendingDelete(null);
    setError(null);
  }, [epoch]);

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

  const refresh = useCallback(() => {
    useWorkspaceStore.getState().bumpTreeVersion();
  }, []);

  const collapseAll = useCallback(() => {
    useWorkspaceStore.getState().collapseAll();
  }, []);

  /**
   * Every mutation funnels through here so a rejected operation surfaces
   * one readable message and the tree still re-reads either way.
   */
  const run = useCallback(async <T,>(op: () => Promise<T>): Promise<T | null> => {
    try {
      setError(null);
      const result = await op();
      useWorkspaceStore.getState().bumpTreeVersion();
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      useWorkspaceStore.getState().bumpTreeVersion();
      return null;
    }
  }, []);

  const startCreate = useCallback((parent: string, type: "file" | "dir") => {
    setError(null);
    setRenaming(null);
    if (parent) useWorkspaceStore.getState().expandPath(parent);
    setDraft({ parent, type });
  }, []);

  const cancelDraft = useCallback(() => setDraft(null), []);

  const commitDraft = useCallback(
    async (rawName: string) => {
      const name = rawName.trim().replace(/^\/+|\/+$/g, "");
      const current = draft;
      setDraft(null);
      if (!current || !name) return;
      const path = joinRel(current.parent, name);
      if (current.type === "dir") {
        const created = await run(() => bridge.rpc("fs.createDir", { path }));
        if (created) useWorkspaceStore.getState().expandPath(created.path);
        return;
      }
      const created = await run(() => bridge.rpc("fs.createFile", { path }));
      // VS Code opens a newly created file straight away.
      if (created) await openFile(created.path);
    },
    [draft, openFile, run]
  );

  const startRename = useCallback((path: string) => {
    setError(null);
    setDraft(null);
    setRenaming(path);
  }, []);

  const cancelRename = useCallback(() => setRenaming(null), []);

  const commitRename = useCallback(
    async (rawName: string) => {
      const from = renaming;
      const name = rawName.trim().replace(/^\/+|\/+$/g, "");
      setRenaming(null);
      if (!from || !name || name === pathBasename(from)) return;
      const to = joinRel(pathDirname(from), name);
      const moved = await run(() => bridge.rpc("fs.rename", { from, to }));
      // Follow the rename in the editor, the way VS Code keeps the tab open.
      const ws = useWorkspaceStore.getState();
      if (moved && ws.selectedPath === from) await openFile(moved.path);
      else if (moved && ws.selectedPath?.startsWith(`${from}/`)) {
        ws.clearSelected();
      }
    },
    [openFile, renaming, run]
  );

  /** Drag-and-drop move: `path` lands inside directory `targetDir`. */
  const move = useCallback(
    async (path: string, targetDir: string) => {
      const to = joinRel(targetDir, pathBasename(path));
      if (to === path) return;
      const moved = await run(() => bridge.rpc("fs.rename", { from: path, to }));
      const ws = useWorkspaceStore.getState();
      if (moved && ws.selectedPath === path) await openFile(moved.path);
      if (targetDir) ws.expandPath(targetDir);
    },
    [openFile, run]
  );

  const requestDelete = useCallback((path: string) => {
    setError(null);
    setPendingDelete(path);
  }, []);

  const cancelDelete = useCallback(() => setPendingDelete(null), []);

  const confirmDelete = useCallback(async () => {
    const path = pendingDelete;
    setPendingDelete(null);
    if (!path) return;
    await run(() => bridge.rpc("fs.delete", { path }));
    // The dispatcher clears a deleted open file, but only once the watcher
    // event lands; doing it here keeps the editor from showing a ghost.
    const ws = useWorkspaceStore.getState();
    if (ws.selectedPath === path || ws.selectedPath?.startsWith(`${path}/`)) {
      ws.clearSelected();
    }
    setClipboard((c) => (c?.path === path ? null : c));
  }, [pendingDelete, run]);

  const copy = useCallback((path: string) => {
    setClipboard({ path, mode: "copy" });
  }, []);

  const cut = useCallback((path: string) => {
    setClipboard({ path, mode: "cut" });
  }, []);

  const paste = useCallback(
    async (targetDir: string) => {
      const entry = clipboard;
      if (!entry) return;
      const to = joinRel(targetDir, pathBasename(entry.path));
      if (entry.mode === "cut") {
        setClipboard(null);
        if (to === entry.path) return;
        await move(entry.path, targetDir);
        return;
      }
      // A copy into the same folder needs a fresh name, not a failure.
      const name =
        to === entry.path
          ? copyName(pathBasename(entry.path), 1)
          : pathBasename(entry.path);
      await run(() =>
        bridge.rpc("fs.copy", { from: entry.path, to: joinRel(targetDir, name) })
      );
      if (targetDir) useWorkspaceStore.getState().expandPath(targetDir);
    },
    [clipboard, move, run]
  );

  const duplicate = useCallback(
    async (path: string) => {
      const dir = pathDirname(path);
      const base = pathBasename(path);
      // Walk the " copy", " copy 2", … series until one is free, so a
      // second duplicate does not just fail with "already exists".
      for (let attempt = 1; attempt <= 20; attempt++) {
        const to = joinRel(dir, copyName(base, attempt));
        try {
          await bridge.rpc("fs.copy", { from: path, to });
          setError(null);
          useWorkspaceStore.getState().bumpTreeVersion();
          return;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          if (!message.includes("Already exists")) {
            setError(message);
            return;
          }
        }
      }
      setError(`Could not find a free name to duplicate ${base}`);
    },
    []
  );

  /** Absolute path, for the "Copy Path" menu item. */
  const absolutePath = useCallback(
    (path: string) => {
      if (!projectPath) return path;
      const sep = projectPath.includes("\\") ? "\\" : "/";
      const native = sep === "\\" ? path.replaceAll("/", "\\") : path;
      return `${projectPath.replace(/[\\/]+$/, "")}${sep}${native}`;
    },
    [projectPath]
  );

  const copyToOsClipboard = useCallback((text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return useMemo(
    () => ({
      tree,
      expanded,
      selectedPath,
      draft,
      renaming,
      clipboard,
      error,
      pendingDelete,
      openFile,
      toggleDir,
      refresh,
      collapseAll,
      startCreate,
      cancelDraft,
      commitDraft,
      startRename,
      cancelRename,
      commitRename,
      move,
      requestDelete,
      cancelDelete,
      confirmDelete,
      copy,
      cut,
      paste,
      duplicate,
      absolutePath,
      copyToOsClipboard,
      clearError,
    }),
    [
      tree,
      expanded,
      selectedPath,
      draft,
      renaming,
      clipboard,
      error,
      pendingDelete,
      openFile,
      toggleDir,
      refresh,
      collapseAll,
      startCreate,
      cancelDraft,
      commitDraft,
      startRename,
      cancelRename,
      commitRename,
      move,
      requestDelete,
      cancelDelete,
      confirmDelete,
      copy,
      cut,
      paste,
      duplicate,
      absolutePath,
      copyToOsClipboard,
      clearError,
    ]
  );
}

export type FileExplorerViewModel = ReturnType<typeof useFileExplorerViewModel>;
