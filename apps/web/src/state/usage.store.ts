import { create } from "zustand";
import type { UsageSnapshot } from "@atelier/protocol";

const EMPTY: UsageSnapshot = {
  available: false,
  status: null,
  windows: [],
  updatedAt: null,
};

/** Latest plan usage snapshot, fed by usage.updated events + the seed RPC. */
interface UsageStore {
  usage: UsageSnapshot;
  set: (usage: UsageSnapshot) => void;
}

export const useUsageStore = create<UsageStore>((set) => ({
  usage: EMPTY,
  set: (usage) => set({ usage }),
}));
