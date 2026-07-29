import { useConnectionStore } from "./connection.store";
import { useDbApprovalStore } from "./db-approval.store";
import { useGitStore } from "./git.store";
import { useGitFlowStore } from "./git-flow.store";
import { useKnowledgeStore } from "./knowledge.store";
import { useMarkdownStore } from "./markdown.store";
import { useSessionsStore } from "./sessions.store";
import { useTerminalStore } from "./terminal.store";
import { useTimelineStore } from "./timeline.store";
import { useUsageStore } from "./usage.store";
import { useContextStore } from "./context.store";
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
  // clear(), not setState: the store keeps a module-level dedupe index of
  // "topic:seq" keys, and each agent's seq restarts low — leaving it would
  // make the new project's first events look like duplicates and vanish.
  useTimelineStore.getState().clear();
  // The catalog is per workspace, and its version dedupe would otherwise
  // refuse to refetch (treeVersion restarts at 0 below), leaving the old
  // project's .md paths in the composer's prompt-file menu.
  useMarkdownStore.setState({
    files: [],
    creating: false,
    fetchedVersion: -1,
    inflightVersion: -1,
  });
  useTerminalStore.setState({ sessions: [], activeTermId: null });
  useDbApprovalStore.setState({ requests: [] });
  useUsageStore.setState({
    usage: { available: false, status: null, windows: [], updatedAt: null },
  });
  useContextStore.setState({ requests: [] });
  useWorkspaceStore.setState((s) => ({
    tree: null,
    treeVersion: 0,
    expanded: new Set<string>(),
    selectedPath: null,
    fileContent: null,
    fileMtime: null,
    rightTab: "chat",
    // Holds a skill body read from the old project's .claude directory.
    skillDetail: null,
    workspaceEpoch: s.workspaceEpoch + 1,
  }));
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
