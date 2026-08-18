import { useEffect } from "react";
import { useMergeConflictEffects } from "@/hooks/useMergeConflictViewModel";
import { alert } from "@/state/alerts.store";
import { useGitMergeStore } from "@/state/git-merge.store";
import { useGitStore } from "@/state/git.store";
import { useWorkspaceStore } from "@/state/workspace.store";

const CONFLICT_ALERT_ID = "git-conflicts";

/**
 * Shell-level home for the merge flow's background behaviour: the effects
 * that finish an AI resolution, and the sticky alert that announces NEW
 * conflicts when the git view is not on screen (a `git pull` in the
 * terminal, a pull run from the panel before navigating away). One click
 * on the alert lands on the merge banner. Rendered by AlertHost.
 */
export function MergeConflictHost() {
  useMergeConflictEffects();
  const visible = useGitMergeStore((s) => s.alertVisible);
  const count = useGitStore(
    (s) => s.live?.conflicts ?? s.status?.conflicts.length ?? 0
  );
  const kind = useGitStore(
    (s) => s.live?.mergeKind ?? s.status?.mergeState?.kind ?? "merge"
  );

  useEffect(() => {
    if (!visible || count === 0) {
      alert.dismiss(CONFLICT_ALERT_ID);
      return;
    }
    const seen = () =>
      useGitMergeStore.getState().set({ alertVisible: false, alertSeenCount: count });
    alert.danger(
      `${count} merge conflict${count === 1 ? "" : "s"}`,
      `${kind} paused`,
      {
        id: CONFLICT_ALERT_ID,
        sticky: true,
        // Dismissing by hand counts as seen, or it would come straight back.
        onDismiss: seen,
        action: {
          label: "Resolve",
          run: () => {
            seen();
            useWorkspaceStore.getState().setActivityView("git");
          },
        },
      }
    );
  }, [visible, count, kind]);

  return null;
}
