import { useCallback, useState } from "react";
import { bridge } from "@/services/bridge-client";
import { useConnectionStore } from "@/state/connection.store";

/** ViewModel for connection status + manual token entry fallback. */
export function useConnectionViewModel() {
  const { state, agentStatus, agentStatusDetail, workspaceRoot } =
    useConnectionStore();
  const [port, setPort] = useState("");
  const [token, setToken] = useState("");

  const saveAndConnect = useCallback(() => {
    if (port) localStorage.setItem("atelier.port", port);
    if (token) localStorage.setItem("atelier.token", token);
    bridge.connect();
  }, [port, token]);

  return {
    state,
    agentStatus,
    agentStatusDetail,
    workspaceRoot,
    port,
    setPort,
    token,
    setToken,
    saveAndConnect,
    reconnect: () => bridge.connect(),
  };
}
