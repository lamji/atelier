import { create } from "zustand";
import type { MarkdownFile, MarkdownStatus } from "@atelier/protocol";
import { upsertFrontmatterStatus } from "@atelier/shared";
import { bridge } from "@/services/bridge-client";
import { useWorkspaceStore } from "@/state/workspace.store";

/**
 * Workspace markdown catalog, shared by the Markdown panel and the
 * composer's prompt-file dropdown. Fetches are keyed by treeVersion so
 * two subscribers refreshing off the same version cost one RPC.
 */
interface MarkdownStore {
  files: MarkdownFile[];
  /** Panel's create form is open. Lives here so the composer's
   *  prompt-file menu can open it from across the app. */
  creating: boolean;
  /** Last treeVersion successfully fetched (-1 = never). */
  fetchedVersion: number;
  /** treeVersion currently being fetched (-1 = idle). */
  inflightVersion: number;
  setCreating: (creating: boolean) => void;
  /** Persist a note's workflow status into its frontmatter. */
  setStatus: (path: string, status: MarkdownStatus) => Promise<void>;
  refresh: (version: number) => Promise<void>;
  /** Refetch regardless of version dedupe (after a UI-side create). */
  forceRefresh: () => Promise<void>;
}

export const useMarkdownStore = create<MarkdownStore>((set, get) => {
  const fetchFiles = async (version: number) => {
    set({ inflightVersion: version });
    try {
      const { files } = await bridge.rpc("fs.markdownFiles", {});
      set({ files, fetchedVersion: version });
    } catch {
      // agent offline; list stays stale
    } finally {
      set({ inflightVersion: -1 });
    }
  };

  return {
    files: [],
    creating: false,
    fetchedVersion: -1,
    inflightVersion: -1,

    setCreating: (creating) => set({ creating }),

    setStatus: async (path, status) => {
      // Optimistic: the badge flips now, the file catches up.
      set({
        files: get().files.map((f) => (f.path === path ? { ...f, status } : f)),
      });
      try {
        const { content } = await bridge.rpc("fs.readFile", { path });
        // Status lives in the file itself, so it survives anything short of
        // deleting the file — and the agent writes the same line when a
        // note-driven task moves it to in-progress or review.
        const next = upsertFrontmatterStatus(content, status);
        await bridge.rpc("fs.writeFile", { path, content: next });
        // If it's open in the editor, hand the editor the new content —
        // otherwise its next autosave would write the status line away.
        const ws = useWorkspaceStore.getState();
        if (ws.selectedPath === path) {
          ws.refreshSelectedFile(next, Date.now());
        }
      } catch {
        await fetchFiles(get().fetchedVersion); // revert to disk truth
      }
    },

    refresh: async (version) => {
      const { fetchedVersion, inflightVersion } = get();
      if (version <= Math.max(fetchedVersion, inflightVersion)) return;
      await fetchFiles(version);
    },

    forceRefresh: async () => {
      await fetchFiles(get().fetchedVersion);
    },
  };
});
