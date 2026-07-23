import { create } from "zustand";
import type { TimelineEntryVm } from "@/types";

const MAX_ENTRIES = 1000;

interface TimelineStore {
  entries: TimelineEntryVm[];
  add: (entry: TimelineEntryVm) => void;
  clear: () => void;
}

export const useTimelineStore = create<TimelineStore>((set) => ({
  entries: [],
  add: (entry) =>
    set((s) => {
      const entries = [...s.entries, entry];
      return {
        entries:
          entries.length > MAX_ENTRIES
            ? entries.slice(entries.length - MAX_ENTRIES)
            : entries,
      };
    }),
  clear: () => set({ entries: [] }),
}));
