import { useConnectionStore } from "./connection.store";
import { useDbApprovalStore } from "./db-approval.store";
import { useGitStore } from "./git.store";
import { useGitFlowStore } from "./git-flow.store";
import { useKnowledgeStore } from "./knowledge.store";
import { useSessionsStore } from "./sessions.store";
import { useTerminalStore } from "./terminal.store";
import { useTimelineStore } from "./timeline.store";
import { useUsageStore } from "./usage.store";
import { useWorkspaceStore } from "./workspace.store";

/**
 * Wipe every workspace-scoped store when switching projects, so the incoming
 * agent rehydrates from a clean slate. zustand's setState MERGES, so passing
 * only data fields resets them while each store's action fns stay intact.
 * Deliberately untouched: theme + projects (session-level, not per-project).
 */
export function resetWorkspaceStores(): void {
  useSessionsStore.setState({
    sessions: {},
    order: [],
    selectedId: null,
    taskMap: {},
  });
  useGitStore.setState({
    status: null,
    commits: [],
    branches: [],
    stateVersion: 0,
    live: null,
    gitDiff: null,
    error: null,
  });
  useGitFlowStore.getState().close();
  useTimelineStore.setState({ entries: [] });
  useTerminalStore.setState({ sessions: [], activeTermId: null });
  useDbApprovalStore.setState({ requests: [] });
  useUsageStore.setState({
    usage: { available: false, status: null, windows: [], updatedAt: null },
  });
  useWorkspaceStore.setState({
    tree: null,
    treeVersion: 0,
    expanded: new Set<string>(),
    selectedPath: null,
    fileContent: null,
    fileMtime: null,
    rightTab: "chat",
  });
  useKnowledgeStore.setState({
    stats: null,
    statsVersion: 0,
    indexing: null,
    recentUpdates: [],
    features: [],
    lessons: [],
    graph: null,
    graphScope: "workspace",
    graphTarget: "",
    graphLoading: false,
    ragQuery: "",
    retrieval: null,
    ragLoading: false,
    featureScan: null,
    welcomeDismissed: false,
  });
  useConnectionStore.setState({
    workspaceRoot: null,
    agentStatus: "idle",
    agentStatusDetail: undefined,
  });
}
