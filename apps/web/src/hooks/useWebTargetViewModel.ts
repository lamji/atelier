import { useEffect, useMemo, useState } from "react";
import {
  packageManifestPaths,
  pubspecPaths,
  resolveComponentPreview,
  type ComponentPreviewRuntime,
} from "@/lib/component-preview";
import { useWorkspaceStore } from "@/state/workspace.store";
import { useConnectionStore } from "@/state/connection.store";

export interface WebTargetVm {
  /** The web app this workspace can preview, or null when it has none. */
  runtime: ComponentPreviewRuntime | null;
  /** True until the first resolution finishes, so nothing flickers. */
  resolving: boolean;
}

/**
 * Whether this workspace has anything a browser could show.
 *
 * The Page preview tab used to be unconditional, which made it a promise the
 * workspace could not always keep: a Go service, an Express API or a bare
 * React Native app would open the pane and sit on a connection error. The
 * tab now exists only where a web target does — and the same resolution
 * picks WHICH target, so a repo with a mobile app and a web app previews the
 * web one rather than the first package.json it finds.
 */
export function useWebTargetViewModel(): WebTargetVm {
  const tree = useWorkspaceStore((s) => s.tree);
  const workspaceRoot = useConnectionStore((s) => s.workspaceRoot);
  const [runtime, setRuntime] = useState<ComponentPreviewRuntime | null>(null);
  const [resolving, setResolving] = useState(true);

  /*
   * Keyed on the manifest LAYOUT, not the tree object. The watcher hands out
   * a new tree on every file change; re-reading every package.json each time
   * a file is saved would be a lot of I/O for an answer that only changes
   * when a project is added or removed.
   */
  const signature = useMemo(
    () =>
      tree
        ? [...packageManifestPaths(tree), ...pubspecPaths(tree)].join("|")
        : "",
    [tree]
  );

  useEffect(() => {
    if (!tree) {
      setRuntime(null);
      setResolving(true);
      return;
    }
    let cancelled = false;
    setResolving(true);
    void resolveComponentPreview(tree, workspaceRoot)
      .then((next) => {
        if (!cancelled) setRuntime(next);
      })
      .catch(() => {
        // No answer is the same as no web target: the tab stays hidden
        // rather than opening onto a pane that cannot work.
        if (!cancelled) setRuntime(null);
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, workspaceRoot]);

  return { runtime, resolving };
}
