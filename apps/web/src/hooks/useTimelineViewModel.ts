import { useMemo } from "react";
import { useSessionsStore } from "@/state/sessions.store";
import { useTimelineStore } from "@/state/timeline.store";
import type { TimelineEntryVm } from "@/types";

/**
 * ViewModel for the agent timeline. Scoped to the selected session so
 * parallel agents each show their own activity; workspace-global events
 * (file.changed from user edits, agent.status) are always shown.
 */
export function useTimelineViewModel(): { entries: TimelineEntryVm[] } {
  const all = useTimelineStore((s) => s.entries);
  const selectedId = useSessionsStore((s) => s.selectedId);

  const entries = useMemo(
    () =>
      all.filter(
        (entry) =>
          entry.conversationId === undefined ||
          entry.conversationId === selectedId
      ),
    [all, selectedId]
  );
  return { entries };
}
