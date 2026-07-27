import { create } from "zustand";
import type { TimelineEntryVm } from "@/types";

/**
 * Cards kept in the Activity feed. The list is not virtualized, so this is
 * also the render budget for the panel — a thousand cards was enough to
 * show up as a stutter on every event.
 */
const MAX_ENTRIES = 300;

interface TimelineStore {
  entries: TimelineEntryVm[];
  add: (entry: TimelineEntryVm) => void;
  clear: () => void;
}

// Non-rendered index kept alongside `entries` for O(1) dedup membership
// checks. Mirrors entries exactly: same keys, kept in sync on evict/clear.
const keySet = new Set<string>();

export const useTimelineStore = create<TimelineStore>((set) => ({
  entries: [],
  add: (entry) =>
    set((s) => {
      // Reconnect replays events from the last seen seq; keys are
      // topic:seq so duplicates drop instead of doubling the timeline.
      if (keySet.has(entry.key)) return s;
      keySet.add(entry.key);
      const entries = [...s.entries, entry];
      if (entries.length > MAX_ENTRIES) {
        const dropped = entries.splice(0, entries.length - MAX_ENTRIES);
        for (const e of dropped) keySet.delete(e.key);
      }
      return { entries };
    }),
  clear: () => {
    keySet.clear();
    set({ entries: [] });
  },
}));
