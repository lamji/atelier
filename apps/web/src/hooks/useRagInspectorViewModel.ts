import { useCallback } from "react";
import { bridge } from "@/services/bridge-client";
import { useKnowledgeStore } from "@/state/knowledge.store";
import { useConnectionStore } from "@/state/connection.store";
import { useWorkspaceStore } from "@/state/workspace.store";

/**
 * ViewModel for the RAG Inspector pane: run a retrieval and show the
 * scored chunks / matched symbols exactly as the agent would see them.
 */
export function useRagInspectorViewModel() {
  const query = useKnowledgeStore((s) => s.ragQuery);
  const retrieval = useKnowledgeStore((s) => s.retrieval);
  const loading = useKnowledgeStore((s) => s.ragLoading);
  const connected = useConnectionStore((s) => s.state === "connected");

  const setQuery = useCallback((value: string) => {
    useKnowledgeStore.getState().setRagQuery(value);
  }, []);

  const run = useCallback(async () => {
    const s = useKnowledgeStore.getState();
    const q = s.ragQuery.trim();
    if (!q || s.ragLoading) return;
    s.setRagLoading(true);
    try {
      const { result } = await bridge.rpc("knowledge.retrieve", {
        query: q,
        k: 12,
      });
      useKnowledgeStore.getState().setRetrieval(result);
    } catch {
      useKnowledgeStore.getState().setRetrieval(null);
    } finally {
      useKnowledgeStore.getState().setRagLoading(false);
    }
  }, []);

  const openChunk = useCallback((path: string) => {
    void bridge
      .rpc("fs.readFile", { path })
      .then((file) => {
        useWorkspaceStore
          .getState()
          .setSelectedFile(path, file.content, file.mtime);
      })
      .catch(() => undefined);
  }, []);

  return { connected, query, retrieval, loading, setQuery, run, openChunk };
}
