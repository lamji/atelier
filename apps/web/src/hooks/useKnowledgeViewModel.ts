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
  const store = useKnowledgeStore();
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
    return () => {
      cancelled = true;
    };
  }, [connected, store.statsVersion]);

  // While indexing, poll stats so `queued` (and the welcome/status-bar
  // indicator) update smoothly even between knowledge.updated flushes.
  const indexingActiveNow =
    store.indexing !== null || (store.stats?.queued ?? 0) > 0;
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
  }, [connected, rightTab, store.statsVersion, loadGraph]);

  // Indexing is active while jobs are queued (from stats) or a live
  // progress event is in flight.
  const indexingActive =
    store.indexing !== null || (store.stats?.queued ?? 0) > 0;

  return {
    connected,
    stats: store.stats,
    indexing: store.indexing,
    indexingActive,
    welcomeDismissed: store.welcomeDismissed,
    dismissWelcome: store.dismissWelcome,
    recentUpdates: store.recentUpdates,
    features: store.features,
    featureScan: store.featureScan,
    scanFeatures,
    lessons: store.lessons,
    graph: store.graph,
    graphScope: store.graphScope,
    graphTarget: store.graphTarget,
    graphLoading: store.graphLoading,
    reindex,
    loadGraph,
    openGraph,
  };
}
