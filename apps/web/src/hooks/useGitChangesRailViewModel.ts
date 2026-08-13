import { useEffect, useMemo, useState } from "react";
import { totalStat, type FileChange } from "@/lib/file-changes";
import { countChanges } from "@/lib/unified-diff";
import {
  captureSessionChanges,
  loadSessionChanges,
  mergeSessionChanges,
  saveSessionChanges,
  type SessionChange,
} from "@/services/session-changes";
import { cliSessionTitle, useCliConsoleStore } from "@/services/cli-console";
import { useConnectionStore } from "@/state/connection.store";
import { useGitStore } from "@/state/git.store";
import { useWorkspaceStore } from "@/state/workspace.store";
import type { ChangesRailViewModel } from "./useChangesRailViewModel";

/**
 * Working-tree source for the changes rail, scoped to one CLI session.
 *
 * CLI mode runs the real codex, which writes to disk directly — its edits
 * never pass through the agent's diff pipeline, so the transcript-fed rail
 * ({@link useChangesRailViewModel}) has nothing to show there. Git does:
 * this reads the working tree and loads a before/after pair per changed
 * file, so the rail beside the CLI shows the same work under a different
 * source.
 *
 * But git knows the repo, not the session, and the tree is normally dirty
 * before a CLI ever opens. Which of those changes are THIS session's is
 * {@link ../services/session-changes}'s job: the rail shows what moved
 * since this session started, and stays empty until something does.
 *
 * Refetches off the git store's `stateVersion`, which the agent bumps on
 * `git.state.changed` — already coalesced repo-side and already driven by
 * the workspace watcher, so no extra polling is needed here.
 */
export function useGitChangesRailViewModel(
  sessionId: string | null
): ChangesRailViewModel {
  const connected = useConnectionStore((s) => s.state === "connected");
  const stateVersion = useGitStore((s) => s.stateVersion);
  const workspaceEpoch = useWorkspaceStore((s) => s.workspaceEpoch);
  const sessions = useCliConsoleStore((s) => s.sessions);
  const titles = useCliConsoleStore((s) => s.titles);
  const resumed = useCliConsoleStore((s) => s.resumed);
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [pinned, setPinned] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Another session's files are not this one's, and neither are another
  // project's. Drop them the moment either changes instead of letting them
  // sit until the refetch lands.
  useEffect(() => {
    setChanges([]);
    setPinned(null);
  }, [sessionId, workspaceEpoch]);

  /** Term id -> the name the session list shows, for shared-file notes. */
  const label = useMemo(() => {
    const byId = new Map<string, string>();
    for (const session of sessions) {
      byId.set(session.termId, cliSessionTitle(session, titles));
    }
    return byId;
  }, [sessions, titles]);

  const providerSession = useMemo(() => {
    if (!sessionId) return null;
    const session = sessions.find((candidate) => candidate.termId === sessionId);
    const providerSessionId = resumed[sessionId];
    return session && providerSessionId
      ? { providerId: session.providerId, sessionId: providerSessionId }
      : null;
  }, [resumed, sessionId, sessions]);

  useEffect(() => {
    if (!connected || !sessionId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      let stored: SessionChange[] = [];
      let captured: SessionChange[] = [];
      if (providerSession) {
        try {
          stored = await loadSessionChanges(
            providerSession.providerId,
            providerSession.sessionId
          );
        } catch {
          // A live capture can still populate the rail if storage is unavailable.
        }
      }
      try {
        captured = await captureSessionChanges(sessionId);
      } catch {
        // Stored review data remains useful when git is temporarily unavailable.
      }
      if (providerSession && captured.length > 0) {
        try {
          await saveSessionChanges(
            providerSession.providerId,
            providerSession.sessionId,
            captured
          );
        } catch {
          // Persistence failure must not hide the live diff from this window.
        }
      }
      const loaded = mergeSessionChanges(stored, captured).map((change) => ({
        path: change.path,
        before: change.before,
        after: change.after,
        ...countChanges(change.before, change.after),
        // Only sessions still in the list get named — a closed one's id
        // means nothing to the reader.
        sharedWith: change.alsoTouchedBy
          .map((id) => label.get(id))
          .filter((name): name is string => !!name),
      }));
      if (!cancelled) {
        setChanges(loaded);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    connected,
    sessionId,
    stateVersion,
    workspaceEpoch,
    label,
    providerSession,
  ]);

  const active =
    changes.find((change) => change.path === pinned) ?? changes[0] ?? null;
  const { added, removed } = useMemo(() => totalStat(changes), [changes]);

  return { changes, active, loading, added, removed, select: setPinned };
}
