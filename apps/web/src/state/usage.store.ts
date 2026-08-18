import { create } from "zustand";
import type { UsageSnapshot } from "@atelier/protocol";

const EMPTY: UsageSnapshot = {
  available: false,
  status: null,
  windows: [],
  ollamaCloudUsage: [],
  updatedAt: null,
};

/** Latest plan usage snapshot, fed by usage.updated events + the seed RPC. */
interface UsageStore {
  usage: UsageSnapshot;
  set: (usage: UsageSnapshot) => void;
}

export const useUsageStore = create<UsageStore>((set) => ({
  usage: EMPTY,
  // The payload arrives as an unvalidated cast (event-dispatcher / RPC), so
  // an agent running older code can send a snapshot without the newer array
  // fields. Coerce those to [] here so every consumer sees a real array and
  // the UI never crashes on `undefined.length`.
  set: (usage) =>
    set({
      usage: {
        ...usage,
        windows: usage.windows ?? [],
        ollamaCloudUsage: usage.ollamaCloudUsage ?? [],
      },
    }),
}));
