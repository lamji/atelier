import { FileDiff, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { basename, type FileChange } from "@/lib/file-changes";
import { UnifiedDiffView } from "./UnifiedDiffView";
import type { ChangesRailViewModel } from "@/hooks/useChangesRailViewModel";

export interface ChangesRailProps {
  vm: ChangesRailViewModel;
  /** Current step, so an in-flight run with no edits yet never reads blank. */
  status: string | null;
}

/**
 * The rail beside the transcript: this conversation's file changes, one tab
 * per file, the selected tab shown as a full-height diff.
 *
 * It is the only place a diff renders — the transcript carries the
 * conversation and the process card carries the steps, so an edit is read
 * once, in the pane shaped for reading it, instead of as a card wedged into
 * the message stream at whatever height it happened to need.
 *
 * Its width is fixed chrome (--changes-rail-w), never animated and never
 * dragged: every pixel it takes comes off the transcript, and re-laying the
 * transcript out mid-run is what pushed the messages out from under their
 * own clip edge. `shrink-0` holds the width; the transcript beside it carries
 * `min-w-0` so the row shrinks there instead of overflowing the window.
 */
export function ChangesRail(props: ChangesRailProps) {
  const { vm } = props;
  return (
    <aside
      className={cn(
        "flex h-full w-[var(--changes-rail-w)] shrink-0 flex-col",
        "overflow-hidden border-l border-border-subtle bg-panel"
      )}
    >
      <TabStrip
        changes={vm.changes}
        activePath={vm.active?.path ?? null}
        added={vm.added}
        removed={vm.removed}
        onSelect={vm.select}
      />
      {vm.active ? (
        <DiffPane change={vm.active} key={vm.active.path} />
      ) : vm.loading ? (
        <LoadingState />
      ) : (
        <EmptyState status={props.status} />
      )}
    </aside>
  );
}

function LoadingState() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/50" />
      <p className="text-xs text-muted-foreground">Loading file changes…</p>
    </div>
  );
}

/**
 * One tab per changed file, plus the run's total at the right. Built to the
 * same rules as the editor's own tab strip (active tab wears the surface of
 * the pane below it, marked by a slim top rule) so the two read as one
 * control, not two takes on the same idea.
 */
function TabStrip(props: {
  changes: FileChange[];
  activePath: string | null;
  added: number;
  removed: number;
  onSelect: (path: string) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Changed files"
      className="flex shrink-0 items-center gap-1 overflow-x-auto px-2.5"
      style={{ height: "var(--tabbar-h)" }}
    >
      {props.changes.map((change) => {
        const active = change.path === props.activePath;
        return (
          <button
            key={change.path}
            type="button"
            role="tab"
            aria-selected={active}
            title={change.path}
            onClick={() => props.onSelect(change.path)}
            className={cn(
              "flex h-8 max-w-[12rem] shrink-0 items-center gap-1.5 rounded-full",
              "px-3 text-xs font-medium transition-colors",
              active
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            )}
          >
            <FileDiff className="h-3.5 w-3.5 shrink-0 opacity-80" />
            <span className="truncate">{basename(change.path)}</span>
          </button>
        );
      })}
      <span aria-hidden className="min-w-0 flex-1" />
      {props.changes.length > 0 && (
        <span className="flex shrink-0 items-center gap-2 pl-2 text-[11px] tabular-nums">
          <span className="text-muted-foreground">
            {props.changes.length} file{props.changes.length === 1 ? "" : "s"}
          </span>
          <LineStat added={props.added} removed={props.removed} />
        </span>
      )}
    </div>
  );
}

/** The active file: its full path, its own stat, and the diff below them. */
function DiffPane(props: { change: FileChange }) {
  const { change } = props;
  return (
    <>
      <div
        className={cn(
          "flex shrink-0 items-center gap-2 border-b border-border-subtle",
          "px-3.5 py-2"
        )}
      >
        {/* Where the file lives. The tab above already carries its name, so
            clipping the tail here costs nothing the reader needs. */}
        <span
          title={change.path}
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
        >
          {change.path}
        </span>
        <LineStat added={change.added} removed={change.removed} />
      </div>
      {change.sharedWith && change.sharedWith.length > 0 && (
        // A file two sessions both wrote is the one case where "this
        // session's changes" is not the whole story, and reviewing it
        // without knowing that is how one session's work gets attributed
        // to the other.
        <p
          title={change.sharedWith.join(", ")}
          className={cn(
            "shrink-0 truncate border-b border-border-subtle px-3 py-1",
            "text-[11px] text-warning"
          )}
        >
          Also changed in {change.sharedWith.join(", ")}
        </p>
      )}
      <div className="min-h-0 flex-1">
        <UnifiedDiffView before={change.before} after={change.after} />
      </div>
    </>
  );
}

function LineStat(props: { added: number; removed: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums">
      {props.added > 0 && <span className="text-success">+{props.added}</span>}
      {props.removed > 0 && (
        <span className="text-destructive">−{props.removed}</span>
      )}
      {props.added === 0 && props.removed === 0 && (
        <span className="text-muted-foreground/60">no change</span>
      )}
    </span>
  );
}

/**
 * Before the first edit lands. The rail is on screen from the start rather
 * than appearing with the first diff: a 420px column and a diff mount
 * arriving in the same frame is the jankiest possible way to deliver the
 * thing you were waiting for. `status` fills the wait when a run is live.
 */
function EmptyState({ status }: { status: string | null }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6">
      <FileDiff className="h-6 w-6 text-muted-foreground/40" />
      <p className="text-xs text-muted-foreground">No file changes yet</p>
      {/* .text-shimmer paints the text through a gradient (color:
          transparent), so it brings its own colour — no text-* class here. */}
      {status && (
        <p className="text-shimmer max-w-full truncate text-[11px]">{status}</p>
      )}
    </div>
  );
}
