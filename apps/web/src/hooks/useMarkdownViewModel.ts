import { useCallback, useEffect, useState } from "react";
import type { MarkdownStatus } from "@atelier/protocol";
import { bridge } from "@/services/bridge-client";
import { useConnectionStore } from "@/state/connection.store";
import { useMarkdownStore } from "@/state/markdown.store";
import { useWorkspaceStore } from "@/state/workspace.store";

/** A burst of writes should cost one catalog read, not one per file. */
const MD_REFETCH_DEBOUNCE_MS = 400;

/** All catalog files live in the app's cache folder inside the workspace. */
const MD_ROOT = ".atelier";

/** `notes/my idea` → `.atelier/notes/my-idea.md`; rejects empty names. */
export function toMarkdownPath(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/\s+/g, "-")
    .replace(/[^\w\-./]/g, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!cleaned || cleaned.replace(/[./]/g, "") === "") return null;
  const withExt = /\.md$/i.test(cleaned) ? cleaned : `${cleaned}.md`;
  return withExt.startsWith(`${MD_ROOT}/`) ? withExt : `${MD_ROOT}/${withExt}`;
}

/** `notes/my-idea.md` → `My Idea` for the seeded heading. */
function titleFromPath(mdPath: string): string {
  const base = mdPath.split("/").pop()!.replace(/\.md$/i, "");
  return base
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Write a new catalog file and refresh the listing; returns its path, or
 * null if the name was unusable or the write failed. Shared by the Markdown
 * panel's create form and the composer's "Create prompt" button so both
 * land in `.atelier/` with the same seeded heading.
 */
export async function createMarkdownFile(
  rawName: string
): Promise<string | null> {
  const mdPath = toMarkdownPath(rawName);
  if (!mdPath) return null;
  try {
    const content = `# ${titleFromPath(mdPath)}\n\n`;
    await bridge.rpc("fs.writeFile", { path: mdPath, content });
    await useMarkdownStore.getState().forceRefresh();
    return mdPath;
  } catch {
    return null;
  }
}

/** ViewModel for the Markdown panel: catalog listing + file creation. */
export function useMarkdownViewModel() {
  const connected = useConnectionStore((s) => s.state === "connected");
  const treeVersion = useWorkspaceStore((s) => s.treeVersion);
  const files = useMarkdownStore((s) => s.files);
  // In the store, not local state: the composer's prompt-file menu opens
  // this form from across the app ("Create markdown file").
  const creating = useMarkdownStore((s) => s.creating);
  const [draftName, setDraftName] = useState("");
  const [saving, setSaving] = useState(false);

  const setCreating = useCallback((v: boolean) => {
    useMarkdownStore.getState().setCreating(v);
  }, []);

  const setStatus = useCallback((path: string, status: MarkdownStatus) => {
    void useMarkdownStore.getState().setStatus(path, status);
  }, []);

  // Same debounce-by-construction as the explorer tree: cleanup cancels
  // the pending read so only the last version in a burst fires.
  useEffect(() => {
    if (!connected) return;
    const timer = setTimeout(
      () => void useMarkdownStore.getState().refresh(treeVersion),
      treeVersion === 0 ? 0 : MD_REFETCH_DEBOUNCE_MS
    );
    return () => clearTimeout(timer);
  }, [connected, treeVersion]);

  /** Creates the drafted file; returns its path so the caller can open it. */
  const create = useCallback(async (): Promise<string | null> => {
    if (saving) return null;
    setSaving(true);
    try {
      const mdPath = await createMarkdownFile(draftName);
      if (mdPath) {
        setDraftName("");
        setCreating(false);
      }
      return mdPath;
    } finally {
      setSaving(false);
    }
  }, [draftName, saving, setCreating]);

  return {
    connected,
    files,
    creating,
    setCreating,
    draftName,
    setDraftName,
    saving,
    create,
    setStatus,
  };
}
