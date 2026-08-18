import {
  ArrowDownToLine,
  ChevronDown,
  ChevronRight,
  CircleAlert,
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
 * Fetch / Pull under the branch line, with the ahead/behind counts. Pull
 * opens its picker ("pull from…") where the command streams into a
 * terminal pane; Fetch runs straight away. There is deliberately no Push
 * here: pushing goes through the commit → push → PR wizard, which runs
 * hooks, handles failures with the AI fix loop and opens the PR. The
 * fold-out drawer keeps the last run's output within reach.
 */
export function SyncBar({
  vm,
  disabled,
}: {
  vm: MergeConflictViewModel;
  disabled?: boolean;
}) {
  const { merge, status } = vm;
  const busy = merge.syncRunning || disabled;
  const behind = status?.behind ?? 0;
  const inMerge = vm.mergeState !== null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-stretch gap-1">
        <Tooltip content="Fetch from origin (no working-tree changes)">
          <button
            onClick={() => void vm.fetch()}
            disabled={busy}
            className="flex h-7 items-center justify-center rounded-lg px-2 text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:opacity-50"
          >
            {merge.syncRunning && merge.syncKind === "fetch" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
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
      </div>

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
