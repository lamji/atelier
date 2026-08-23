import { useEffect, useState } from "react";
import {
  Check,
  CircleAlert,
  GitMerge,
  Loader2,
  Maximize2,
  Sparkles,
  Square,
  Undo2,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/error-text";
import { STAGE_LABELS } from "@/lib/stage-labels";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import type { MergeConflictViewModel } from "@/hooks/useMergeConflictViewModel";
import { AiResolveModal } from "./AiResolveModal";
import { AiResolverModal } from "./AiResolverModal";
import type { SessionVm } from "@/state/sessions.store";
import type { GitMergeKind } from "@atelier/protocol";

const KIND_TITLE: Record<GitMergeKind, string> = {
  merge: "Merge in progress",
  rebase: "Rebase in progress",
  "cherry-pick": "Cherry-pick in progress",
  revert: "Revert in progress",
};

const KIND_FINISH: Record<GitMergeKind, string> = {
  merge: "Commit merge",
  rebase: "Continue rebase",
  "cherry-pick": "Continue cherry-pick",
  revert: "Continue revert",
};

/**
 * One line of "what is it doing", for the row that opens the transcript:
 * the running step while it works, the last thing it said afterwards.
 */
function aiHeadline(session: SessionVm, working: boolean): string {
  if (working) {
    const running = [...session.actions]
      .reverse()
      .find((action) => action.status === "running");
    if (running) return running.label;
    return session.stage ? STAGE_LABELS[session.stage] : "starting…";
  }
  const last = [...session.items]
    .reverse()
    .find((item) => item.role === "assistant");
  return last ? last.text.replace(/\s+/g, " ").slice(0, 80) : "transcript";
}

/** MERGE_MSG minus git's commented "# Conflicts:" trailer. */
function cleanMergeMessage(message: string | undefined): string {
  return (message ?? "")
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();
}

/**
 * The card that takes over the top of the git panel while a merge-like
 * operation is mid-flight. Says what is merging into what, how far the
 * resolution has got, and holds the three exits: resolve with AI, complete,
 * abort. Everything file-level lives in the Conflicts section beside it.
 */
export function MergeBanner({ vm }: { vm: MergeConflictViewModel }) {
  const { mergeState, merge, conflicts, aiSession, aiWorking } = vm;
  const [askAi, setAskAi] = useState(false);
  const [transcript, setTranscript] = useState(false);
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prepared = cleanMergeMessage(mergeState?.message);
  useEffect(() => setMessage(prepared), [prepared]);

  const total = Math.max(merge.trackedConflicts.length, conflicts.length);
  const remaining = conflicts.length;
  const resolved = Math.max(0, total - remaining);
  const allResolved = remaining === 0;
  const kind = mergeState?.kind ?? "merge";
  const running = merge.syncRunning && merge.syncKind === "continue";

  const act = (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    void fn()
      .catch((e: unknown) =>
        setError(errorText(e).replace(/^Error:\s*/, "").slice(0, 200))
      )
      .finally(() => setBusy(false));
  };

  const doAi = (guidance: string, model: string) => {
    void vm.aiResolve(conflicts, guidance, model);
  };

  if (!mergeState) return null;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl p-3 shadow-sm ring-1",
        allResolved
          ? "bg-success/5 ring-success/30"
          : "bg-destructive/5 ring-destructive/30"
      )}
    >
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg",
            allResolved ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"
          )}
        >
          <GitMerge className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold">{KIND_TITLE[kind]}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            <span className="font-mono">{mergeState.theirs}</span>
            <span className="mx-1 opacity-60">→</span>
            <span className="font-mono">{mergeState.ours}</span>
          </p>
        </div>
      </div>

      {/* Progress */}
      <div className="mt-2.5">
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>
            {allResolved
              ? total === 0
                ? "No conflicts — ready to finish"
                : "All conflicts resolved"
              : `${remaining} conflict${remaining === 1 ? "" : "s"} left`}
          </span>
          {total > 0 && (
            <span className="tabular-nums">
              {resolved}/{total} resolved
            </span>
          )}
        </div>
        {total > 0 && (
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-black/20">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-300",
                allResolved ? "bg-success" : "bg-destructive"
              )}
              style={{ width: `${(resolved / total) * 100}%` }}
            />
          </div>
        )}
      </div>

      {(error || merge.aiSummary) && (
        <p
          className={cn(
            "mt-2 flex items-start gap-1.5 rounded-lg px-2 py-1 text-[11px]",
            error ? "bg-destructive/10 text-destructive" : "bg-black/10 text-muted-foreground"
          )}
        >
          {error ? (
            <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" />
          ) : (
            <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
          )}
          <span className="min-w-0 flex-1">{error ?? merge.aiSummary}</span>
        </p>
      )}

      {/* Commit message — only for a merge, and only once it can be made */}
      {kind === "merge" && allResolved && (
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
          placeholder="Merge commit message"
          className="mt-2 max-h-40 min-h-12 resize-y text-xs"
        />
      )}

      {/* Actions */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {allResolved ? (
          <Button
            size="sm"
            disabled={busy || running || aiWorking}
            onClick={() =>
              act(() => vm.complete(kind === "merge" ? message : undefined))
            }
          >
            {running ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="mr-1.5 h-3.5 w-3.5" />
            )}
            {KIND_FINISH[kind]}
          </Button>
        ) : aiWorking ? (
          <Tooltip
            content={
              aiSession?.cancelling
                ? "Stopping — finishing the current step"
                : "Stop the AI resolver"
            }
          >
            <Button
              size="sm"
              variant="destructive"
              disabled={aiSession?.cancelling}
              onClick={vm.cancelAi}
            >
              {aiSession?.cancelling ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Stopping…
                </>
              ) : (
                <>
                  <Square className="mr-1.5 h-3 w-3 fill-current" />
                  Stop AI
                </>
              )}
            </Button>
          </Tooltip>
        ) : (
          <Tooltip content="The model you pick reads both sides of every conflicted file and rewrites them; you review before completing">
            <Button size="sm" disabled={busy || running} onClick={() => setAskAi(true)}>
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              Resolve all with AI
            </Button>
          </Tooltip>
        )}

        {confirmAbort ? (
          <span className="flex items-center gap-1 rounded-lg bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive">
            Discard the {kind}?
            <button
              onClick={() => {
                setConfirmAbort(false);
                act(() => vm.abort());
              }}
              className="rounded px-1 font-medium hover:bg-destructive/20"
            >
              Abort
            </button>
            <button
              onClick={() => setConfirmAbort(false)}
              className="rounded p-0.5 hover:bg-destructive/20"
              aria-label="Keep going"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ) : (
          <Tooltip content={`git ${kind} --abort — back to before the ${kind}`}>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive/80 hover:text-destructive"
              disabled={busy || running || aiWorking}
              onClick={() => setConfirmAbort(true)}
            >
              <Undo2 className="mr-1.5 h-3.5 w-3.5" />
              Abort
            </Button>
          </Tooltip>
        )}
      </div>

      {/* The resolver's own output is a wall of prose in a panel this
          narrow, so the banner keeps the status line and hands the reading
          to a modal with room for it. */}
      {aiSession && (aiWorking || aiSession.items.length > 0) && (
        <div className="mt-2.5 border-t border-white/5 pt-2">
          <Tooltip content="Open the resolver's transcript">
            <button
              onClick={() => setTranscript(true)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1",
                "text-[11px] text-muted-foreground hover:bg-accent/60",
                "hover:text-foreground"
              )}
            >
              {aiWorking ? (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
              ) : (
                <Sparkles className="h-3 w-3 shrink-0 text-primary/70" />
              )}
              <span className="shrink-0">AI resolver</span>
              <span className="min-w-0 flex-1 truncate text-left opacity-70">
                {aiHeadline(aiSession, aiWorking)}
              </span>
              <Maximize2 className="h-3 w-3 shrink-0 opacity-70" />
            </button>
          </Tooltip>
        </div>
      )}

      <AiResolverModal
        open={transcript}
        session={aiSession ?? null}
        working={aiWorking}
        onClose={() => setTranscript(false)}
        onCancel={vm.cancelAi}
      />

      <AiResolveModal
        open={askAi}
        paths={conflicts}
        onClose={() => setAskAi(false)}
        onSubmit={doAi}
      />
    </div>
  );
}
