import { useEffect, useMemo, useState } from "react";
import {
  collapseFileChanges,
  totalStat,
  type DiffSource,
  type FileChange,
} from "@/lib/file-changes";
import { useSessionsStore, type LiveDiff } from "@/state/sessions.store";
import type { ChatItemVm } from "@/types";

export interface ChangesRailViewModel {
  /** One tab per file the agent touched in this conversation. */
  changes: FileChange[];
  /** The tab being shown, or null while the run has produced no edits. */
  active: FileChange | null;
  /** True while this rail's source is fetching its current file diffs. */
  loading: boolean;
  added: number;
  removed: number;
  select: (path: string) => void;
}

/**
 * ViewModel for the changes rail: collapses the conversation's edits into one
 * tab per file and tracks which tab is showing.
 *
 * The rail's width is not here — it is fixed chrome (--changes-rail-w), not
 * state, so nothing about it can move the transcript.
 *
 * Takes the transcript and the live diffs as arguments rather than
 * subscribing again — {@link useChatViewModel} already reads both, and a
 * second subscription would re-render the rail on every streamed token.
 */
export function useChangesRailViewModel(
  items: ChatItemVm[],
  liveDiffs: LiveDiff[]
): ChangesRailViewModel {
  const selectedId = useSessionsStore((s) => s.selectedId);
  const [pinned, setPinned] = useState<string | null>(null);

  // Another conversation's tabs are not this one's; drop the pin so the rail
  // opens on whatever the newly selected chat last edited.
  useEffect(() => setPinned(null), [selectedId]);

  const sources = useMemo<DiffSource[]>(() => {
    const fromTranscript = items.flatMap((item) =>
      item.role === "diff" && item.diff
        ? [{ id: item.id, ...item.diff }]
        : []
    );
    return [...fromTranscript, ...liveDiffs];
  }, [items, liveDiffs]);

  // Keyed on the id signature, not the array. Streaming gives `items` a new
  // identity on every delta, and re-running the Myers line diff for every
  // file on every token is what turns a long answer into a slideshow. Each
  // edit carries a fresh id, so the ids changing IS the content changing.
  const signature = sources.map((s) => s.id).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const changes = useMemo(() => collapseFileChanges(sources), [signature]);

  // Follow the file the agent just touched, unless a tab was picked by hand.
  const newest = sources[sources.length - 1]?.path ?? null;
  const active =
    changes.find((c) => c.path === (pinned ?? newest)) ?? changes[0] ?? null;

  const { added, removed } = useMemo(() => totalStat(changes), [changes]);

  return { changes, active, loading: false, added, removed, select: setPinned };
}
