import { useCallback, useEffect } from "react";
import { bridge } from "@/services/bridge-client";
import {
  useKnowledgeStore,
  type GraphScope,
} from "@/state/knowledge.store";
import { useConnectionStore } from "@/state/connection.store";
import { useWorkspaceStore } from "@/state/workspace.store";

/**
 * ViewModel for the Knowledge side panel and the Graph pane: index stats,
 * indexing progress, re-index action, and graph scope/loading.
 */
export function useKnowledgeViewModel() {
  // Per-field selectors: indexing progress ticks several times a second
  // during a scan, and only the progress readouts should follow it.
  const stats = useKnowledgeStore((s) => s.stats);
  const statsVersion = useKnowledgeStore((s) => s.statsVersion);
  const indexing = useKnowledgeStore((s) => s.indexing);
  const recentUpdates = useKnowledgeStore((s) => s.recentUpdates);
  const features = useKnowledgeStore((s) => s.features);
  const featureScan = useKnowledgeStore((s) => s.featureScan);
  const lessons = useKnowledgeStore((s) => s.lessons);
  const wikiPages = useKnowledgeStore((s) => s.wikiPages);
  const wikiLint = useKnowledgeStore((s) => s.wikiLint);
  const graph = useKnowledgeStore((s) => s.graph);
  const graphScope = useKnowledgeStore((s) => s.graphScope);
  const graphTarget = useKnowledgeStore((s) => s.graphTarget);
  const graphLoading = useKnowledgeStore((s) => s.graphLoading);
  const welcomeDismissed = useKnowledgeStore((s) => s.welcomeDismissed);
  const dismissWelcome = useKnowledgeStore((s) => s.dismissWelcome);
  const connectionState = useConnectionStore((s) => s.state);
  const setRightTab = useWorkspaceStore((s) => s.setRightTab);
  const rightTab = useWorkspaceStore((s) => s.rightTab);
  const connected = connectionState === "connected";

  // Stats follow connection + knowledge.updated events.
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void bridge
      .rpc("knowledge.stats", {})
      .then(({ stats }) => {
        if (!cancelled) useKnowledgeStore.getState().setStats(stats);
      })
      .catch(() => undefined);
    void bridge
      .rpc("knowledge.features.list", {})
      .then(({ features }) => {
        if (!cancelled) useKnowledgeStore.getState().setFeatures(features);
      })
      .catch(() => undefined);
    void bridge
      .rpc("knowledge.lessons.list", { limit: 20 })
      .then(({ lessons }) => {
        if (!cancelled) useKnowledgeStore.getState().setLessons(lessons);
      })
      .catch(() => undefined);
    void bridge
      .rpc("knowledge.wiki.list", {})
      .then(({ pages, lint }) => {
        if (!cancelled) useKnowledgeStore.getState().setWiki(pages, lint);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connected, statsVersion]);

  // While indexing, poll stats so `queued` (and the welcome/status-bar
  // indicator) update smoothly even between knowledge.updated flushes.
  const indexingActiveNow = indexing !== null || (stats?.queued ?? 0) > 0;
  useEffect(() => {
    if (!connected || !indexingActiveNow) return;
    const timer = setInterval(() => {
      void bridge
        .rpc("knowledge.stats", {})
        .then(({ stats }) => useKnowledgeStore.getState().setStats(stats))
        .catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [connected, indexingActiveNow]);

  const reindex = useCallback(async (force = false) => {
    await bridge.rpc("knowledge.indexWorkspace", { force }).catch(() => undefined);
  }, []);

  /** Kick the route→feature scan (Haiku summarizes each page/endpoint). */
  /** Opens a wiki page in the editor tab, like a click in the explorer. */
  const openWikiPage = useCallback(async (path: string) => {
    try {
      const file = await bridge.rpc("fs.readFile", { path });
      useWorkspaceStore
        .getState()
        .setSelectedFile(path, file.content, file.mtime);
    } catch {
      // The page may have been deleted since the list was fetched.
    }
  }, []);

  const scanFeatures = useCallback(async () => {
    useKnowledgeStore.getState().setFeatureScan({
      phase: "discover",
      done: 0,
      total: 0,
    });
    await bridge.rpc("knowledge.features.scan", {}).catch(() => {
      useKnowledgeStore.getState().setFeatureScan(null);
    });
  }, []);

  const loadGraph = useCallback(async (scope: GraphScope, target?: string) => {
    const s = useKnowledgeStore.getState();
    s.setGraphScope(scope, target ?? "");
    s.setGraphLoading(true);
    try {
      const { graph } = await bridge.rpc("knowledge.graph", {
        scope,
        target: target || undefined,
        depth: 1,
      });
      useKnowledgeStore.getState().setGraph(graph);
    } catch {
      useKnowledgeStore.getState().setGraph(null);
    } finally {
      useKnowledgeStore.getState().setGraphLoading(false);
    }
  }, []);

  const openGraph = useCallback(
    (scope: GraphScope, target?: string) => {
      setRightTab("graph");
      void loadGraph(scope, target);
    },
    [loadGraph, setRightTab]
  );

  // Zero-click graph: load the current scope whenever the pane becomes
  // visible, and re-pull it when the knowledge index changes underneath
  // (statsVersion moves on every knowledge.updated event).
  useEffect(() => {
    if (!connected || rightTab !== "graph") return;
    const s = useKnowledgeStore.getState();
    if (s.graphLoading) return;
    void loadGraph(s.graphScope, s.graphTarget || undefined);
  }, [connected, rightTab, statsVersion, loadGraph]);

  return {
    connected,
    stats,
    indexing,
    // Indexing is active while jobs are queued (from stats) or a live
    // progress event is in flight.
    indexingActive: indexingActiveNow,
    welcomeDismissed,
    dismissWelcome,
    recentUpdates,
    features,
    featureScan,
    scanFeatures,
    lessons,
    wikiPages,
    wikiLint,
    openWikiPage,
    graph,
    graphScope,
    graphTarget,
    graphLoading,
    reindex,
    loadGraph,
    openGraph,
  };
}
