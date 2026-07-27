import { create } from "zustand";
import type { ContextRequestStats } from "@atelier/protocol";

const MAX_REQUESTS = 50;

/**
 * Recent context-engineering stats, fed by context.stats events plus the
 * context.stats RPC seed. Newest first; upserts by requestId so the
 * assembly-time estimate and the later SDK-actuals update merge into one
 * row instead of appearing twice.
 */
interface ContextStore {
  requests: ContextRequestStats[];
  add: (stats: ContextRequestStats) => void;
  hydrate: (requests: ContextRequestStats[]) => void;
}

export const useContextStore = create<ContextStore>((set) => ({
  requests: [],
  add: (stats) =>
    set((s) => ({
      requests: [
        stats,
        ...s.requests.filter((r) => r.requestId !== stats.requestId),
      ].slice(0, MAX_REQUESTS),
    })),
  hydrate: (requests) => set({ requests: requests.slice(0, MAX_REQUESTS) }),
}));
