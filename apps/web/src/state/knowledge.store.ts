import { create } from "zustand";
import type {
  Feature,
  IndexStats,
  KnowledgeGraph,
  Lesson,
  RetrievalResult,
  WikiLintFinding,
  WikiPageInfo,
} from "@atelier/protocol";

export interface IndexingProgress {
  phase: "scan" | "parse" | "resolve" | "embed" | "features";
  done: number;
  total: number;
  currentPath?: string;
}

export interface KnowledgeUpdate {
  files: string[];
  symbolsDelta: number;
  edgesDelta: number;
  embeddingsDelta: number;
  ts: number;
}

export type GraphScope = "workspace" | "file" | "symbol" | "feature";

interface KnowledgeStore {
  stats: IndexStats | null;
  /** Bumped by knowledge.updated events; VMs refetch stats when it moves. */
  statsVersion: number;
  indexing: IndexingProgress | null;
  recentUpdates: KnowledgeUpdate[];
  features: Feature[];
  lessons: Lesson[];
  /** Feature-wiki pages with live freshness, plus lint findings. */
  wikiPages: WikiPageInfo[];
  wikiLint: WikiLintFinding[];
  graph: KnowledgeGraph | null;
  graphScope: GraphScope;
  graphTarget: string;
  graphLoading: boolean;
  ragQuery: string;
  retrieval: RetrievalResult | null;
  ragLoading: boolean;
  /** Live route→feature scan progress, null when idle. */
  featureScan: {
    phase: "discover" | "summarize" | "done";
    done: number;
    total: number;
    current?: string;
  } | null;
  /** The launch welcome/indexing page is dismissed for this session. */
  welcomeDismissed: boolean;
  setStats: (stats: IndexStats) => void;
  setFeatureScan: (scan: KnowledgeStore["featureScan"]) => void;
  bumpStatsVersion: () => void;
  setIndexing: (progress: IndexingProgress | null) => void;
  noteUpdate: (update: KnowledgeUpdate) => void;
  setFeatures: (features: Feature[]) => void;
  setLessons: (lessons: Lesson[]) => void;
  setWiki: (pages: WikiPageInfo[], lint: WikiLintFinding[]) => void;
  setGraph: (graph: KnowledgeGraph | null) => void;
  setGraphScope: (scope: GraphScope, target?: string) => void;
  setGraphLoading: (loading: boolean) => void;
  setRagQuery: (query: string) => void;
  setRetrieval: (result: RetrievalResult | null) => void;
  setRagLoading: (loading: boolean) => void;
  dismissWelcome: () => void;
}

export const useKnowledgeStore = create<KnowledgeStore>((set) => ({
  stats: null,
  statsVersion: 0,
  indexing: null,
  recentUpdates: [],
  features: [],
  lessons: [],
  wikiPages: [],
  wikiLint: [],
  graph: null,
  graphScope: "workspace",
  graphTarget: "",
  graphLoading: false,
  ragQuery: "",
  retrieval: null,
  ragLoading: false,
  featureScan: null,
  welcomeDismissed: false,

  setStats: (stats) => set({ stats }),
  setFeatureScan: (featureScan) => set({ featureScan }),
  bumpStatsVersion: () => set((s) => ({ statsVersion: s.statsVersion + 1 })),
  setIndexing: (indexing) => set({ indexing }),
  noteUpdate: (update) =>
    set((s) => ({ recentUpdates: [update, ...s.recentUpdates].slice(0, 20) })),
  setFeatures: (features) => set({ features }),
  setLessons: (lessons) => set({ lessons }),
  setWiki: (wikiPages, wikiLint) => set({ wikiPages, wikiLint }),
  setGraph: (graph) => set({ graph }),
  setGraphScope: (graphScope, graphTarget = "") =>
    set({ graphScope, graphTarget }),
  setGraphLoading: (graphLoading) => set({ graphLoading }),
  setRagQuery: (ragQuery) => set({ ragQuery }),
  setRetrieval: (retrieval) => set({ retrieval }),
  setRagLoading: (ragLoading) => set({ ragLoading }),
  dismissWelcome: () => set({ welcomeDismissed: true }),
}));
