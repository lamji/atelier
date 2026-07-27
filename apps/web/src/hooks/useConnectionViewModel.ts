import { bridge } from "@/services/bridge-client";
import { useConnectionStore } from "@/state/connection.store";

/**
 * ViewModel for connection status (status bar). Recovery from a dropped
 * connection is owned by useConnectionGateViewModel, which knows whether the
 * supervisor or just the project's agent is missing.
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
    reconnect: () => bridge.connect(),
  };
}
