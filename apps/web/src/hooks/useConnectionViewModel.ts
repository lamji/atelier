import { useProjectsStore } from "@/state/projects.store";
import { useConnectionStore } from "@/state/connection.store";
import { openWorkspace } from "@/services/project-switch";

/**
 * ViewModel for connection status (status bar). A dead port means the
 * agent process died; reconnect re-attaches through the desktop main,
 * which restarts the agent if needed.
 */
export function useConnectionViewModel() {
  const state = useConnectionStore((s) => s.state);
  const agentStatus = useConnectionStore((s) => s.agentStatus);
  const agentStatusDetail = useConnectionStore((s) => s.agentStatusDetail);
  const workspaceRoot = useConnectionStore((s) => s.workspaceRoot);

  return {
    state,
    agentStatus,
    agentStatusDetail,
    workspaceRoot,
    reconnect: () => {
      const id = useProjectsStore.getState().activeId;
      if (id) void openWorkspace(id).catch(() => undefined);
    },
  };
}
