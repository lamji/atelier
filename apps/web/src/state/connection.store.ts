import { create } from "zustand";
import type { AgentStatus, ConnectionState } from "@/types";

interface ConnectionStore {
  state: ConnectionState;
  agentStatus: AgentStatus;
  agentStatusDetail?: string;
  workspaceRoot: string | null;
  setState: (state: ConnectionState) => void;
  setAgentStatus: (status: AgentStatus, detail?: string) => void;
  setWorkspaceRoot: (root: string | null) => void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  state: "disconnected",
  agentStatus: "idle",
  agentStatusDetail: undefined,
  workspaceRoot: null,
  setState: (state) => set({ state }),
  setAgentStatus: (agentStatus, agentStatusDetail) =>
    set({ agentStatus, agentStatusDetail }),
  setWorkspaceRoot: (workspaceRoot) => set({ workspaceRoot }),
}));
