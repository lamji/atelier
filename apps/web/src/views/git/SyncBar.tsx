import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  GitPullRequestArrow,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useStickToBottom } from "@/hooks/useStickToBottom";
import { Tooltip } from "@/components/ui/tooltip";
import type { MergeConflictViewModel } from "@/hooks/useMergeConflictViewModel";
import type { SyncKind } from "@/state/git-merge.store";

/**
 * Fetch / Pull / Rebase under the branch line, with the ahead/behind
 * counts. Pull and Rebase open their pickers, where the command streams
 * into a terminal pane; Fetch runs straight away — it only moves
 * remote-tracking refs, so there is nothing to configure and nothing of
 * yours it can touch. There is deliberately no Push
 * *picker* here: pushing after a fresh commit goes through the commit →
 * push → PR wizard, which runs hooks, handles failures with the AI fix
 * loop and opens the PR. When commits already exist ahead of the remote
 * with nothing left to commit (e.g. made from a terminal), the wizard has
 * no commit step to start it from — `onPush` opens it straight on the
 * push stage instead, so those commits aren't stuck unpushable. The
 * fold-out drawer keeps the last run's output within reach.
 */
export function SyncBar({
  vm,
  disabled,
  ahead,
  onPush,
}: {
  vm: MergeConflictViewModel;
  disabled?: boolean;
  /** Commits on this branch not yet on the remote. */
  ahead?: number;
  /** Opens the push wizard directly on the push stage. */
  onPush?: () => void;
}) {
  const { merge, status } = vm;
  const busy = merge.syncRunning || disabled;
  const behind = status?.behind ?? 0;
  const inMerge = vm.mergeState !== null;
  const showPush = (ahead ?? 0) > 0 && !inMerge && onPush;

  return (
    <div className="space-y-1.5">
      <div className="flex items-stretch gap-1">
        <Tooltip content="git fetch --all --prune --tags — every remote branch and tag, brought down locally. Nothing is merged, so it is safe to run any time.">
          <button
            onClick={() => void vm.fetch()}
            disabled={busy}
            className={cn(
              "flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 text-xs",
              "bg-secondary/70 hover:bg-secondary disabled:opacity-50"
            )}
          >
            {merge.syncRunning && merge.syncKind === "fetch" ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate">Fetch</span>
          </button>
        </Tooltip>

        <Tooltip
          content={
            inMerge
              ? "Finish or abort the merge in progress first"
              : "Pull from a remote branch…"
          }
        >
          <button
            onClick={() => vm.openSync("pull")}
            disabled={busy || inMerge}
            className={cn(
              "flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 text-xs",
              "bg-secondary/70 hover:bg-secondary disabled:opacity-50",
              behind > 0 && !inMerge && "text-primary"
            )}
          >
            {merge.syncRunning && merge.syncKind === "pull" ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : (
              <ArrowDownToLine className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate">Pull</span>
            {behind > 0 && (
              <span className="ml-auto shrink-0 rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold tabular-nums text-primary">
                {behind}
              </span>
            )}
          </button>
        </Tooltip>

        <Tooltip
          content={
            inMerge
              ? "Finish or abort the operation in progress first"
              : "Replay this branch on top of another branch…"
          }
        >
          <button
            onClick={() => vm.openSync("rebase")}
            disabled={busy || inMerge}
            className={cn(
              "flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 text-xs",
              "bg-secondary/70 hover:bg-secondary disabled:opacity-50"
            )}
          >
            {merge.syncRunning && merge.syncKind === "rebase" ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : (
              <GitPullRequestArrow className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate">Rebase</span>
          </button>
        </Tooltip>
      </div>

      {showPush && (
        <Tooltip content={`Push ${ahead} commit${ahead === 1 ? "" : "s"} to origin`}>
          <button
            onClick={onPush}
            disabled={busy}
            className="flex h-7 w-full items-center justify-center gap-1.5 rounded-lg bg-primary/12 px-2 text-xs font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
          >
            <ArrowUpFromLine className="h-3.5 w-3.5 shrink-0" />
            Push
            <span className="rounded-full bg-primary/20 px-1.5 text-[10px] font-semibold tabular-nums">
              {ahead}
            </span>
          </button>
        </Tooltip>
      )}

      {merge.syncError && (
        <p className="flex items-start gap-1.5 rounded-lg bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{merge.syncError}</span>
          <button
            onClick={vm.clearError}
            className="shrink-0 rounded p-0.5 hover:bg-destructive/20"
            aria-label="Dismiss"
          >
            <X className="h-3 w-3" />
          </button>
        </p>
      )}

      {merge.syncKind && merge.syncOutput && !merge.syncModal && (
        <SyncOutput
          kind={merge.syncKind}
          output={merge.syncOutput}
          running={merge.syncRunning}
          open={merge.outputOpen}
          onToggle={vm.toggleOutput}
        />
      )}
    </div>
  );
}

const KIND_LABEL: Record<SyncKind, string> = {
  fetch: "fetch",
  pull: "pull",
  push: "push",
  continue: "complete merge",
  checkout: "checkout",
  rebase: "rebase",
};

/** Terminal-style fold-out of the last sync run; follows the stream. */
function SyncOutput(props: {
  kind: SyncKind;
  output: string;
  running: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { ref, onScroll } = useStickToBottom<HTMLPreElement>([props.output]);
  return (
    <div className="rounded-lg bg-black/25">
      <button
        onClick={props.onToggle}
        className="flex w-full items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
      >
        {props.open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span className="font-mono">git {KIND_LABEL[props.kind]}</span>
        {props.running && <Loader2 className="ml-1 h-3 w-3 animate-spin" />}
        <span className="ml-auto text-[10px] opacity-70">
          {props.open ? "hide output" : "show output"}
        </span>
      </button>
      {props.open && (
        <pre
          ref={ref}
          onScroll={onScroll}
          className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words px-2 pb-2 font-mono text-[10.5px] leading-relaxed text-neutral-300"
        >
          {props.output}
        </pre>
      )}
    </div>
  );
}
