import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  GitMerge,
  Loader2,
  Sparkles,
  Square,
  Undo2,
  X,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/error-text";
import { STAGE_LABELS } from "@/lib/stage-labels";
import { useElapsed } from "@/hooks/useElapsed";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import type { MergeConflictViewModel } from "@/hooks/useMergeConflictViewModel";
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
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiOpen, setAiOpen] = useState(true);
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

  const doAi = () => {
    void vm.aiResolve(conflicts, aiPrompt);
    setAiPrompt("");
    setAiOpen(true);
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
          <Tooltip content="Sonnet reads both sides of every conflicted file and rewrites them; you review before completing">
            <Button size="sm" disabled={busy || running} onClick={doAi}>
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

      {/* AI activity: transcript of the resolver task + extra instructions */}
      {(aiSession || !allResolved) && (
        <div className="mt-2.5 border-t border-white/5 pt-2">
          <button
            onClick={() => setAiOpen((v) => !v)}
            className="flex w-full items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {aiOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <Sparkles className="h-3 w-3 text-primary/70" />
            AI resolver
            {aiWorking && <Loader2 className="ml-1 h-3 w-3 animate-spin text-primary" />}
          </button>
          {aiOpen && (
            <div className="mt-1.5 space-y-1.5">
              {aiSession && aiSession.items.length > 0 && (
                <AiTranscript session={aiSession} />
              )}
              {aiWorking && aiSession && <AiProgress session={aiSession} />}
              {!aiWorking && !allResolved && (
                <Textarea
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  placeholder="Optional guidance, e.g. “prefer the incoming schema, keep our logging”"
                  rows={2}
                  className="min-h-0 resize-none text-[11px]"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) doAi();
                  }}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Live trace of the resolver task: current stage, last tool calls, timer. */
function AiProgress({ session }: { session: SessionVm }) {
  const elapsed = useElapsed(session.taskStartedAt);
  const recent = session.actions.slice(-3);
  const running = recent.find((a) => a.status === "running");
  const headline =
    running?.label ?? (session.stage ? STAGE_LABELS[session.stage] : "starting…");
  return (
    <div className="rounded-lg bg-black/15 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
        <span className="min-w-0 flex-1 truncate text-[11px]">{headline}</span>
        {session.taskStartedAt !== null && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
          </span>
        )}
      </div>
      {recent.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {recent.map((action) => (
            <p
              key={action.id}
              className="flex items-center gap-1.5 truncate font-mono text-[10px] text-muted-foreground"
            >
              {action.status === "running" ? (
                <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin text-primary/70" />
              ) : action.status === "done" ? (
                <Check className="h-2.5 w-2.5 shrink-0 text-success" />
              ) : (
                <CircleAlert className="h-2.5 w-2.5 shrink-0 text-destructive" />
              )}
              <span className="truncate">{action.label}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/** The resolver conversation, newest at the bottom; edits shown as log lines. */
function AiTranscript({ session }: { session: SessionVm }) {
  const items = useMemo(() => session.items.slice(-12), [session.items]);
  return (
    <div className="max-h-44 space-y-1.5 overflow-y-auto rounded-lg bg-black/15 p-2">
      {items.map((item) => {
        if (item.role === "log" || item.role === "diff") {
          return (
            <p key={item.id} className="truncate font-mono text-[10px] text-muted-foreground">
              {item.role === "diff" ? `Edited ${item.text}` : item.text}
            </p>
          );
        }
        return (
          <div
            key={item.id}
            className={cn(
              "text-[11px]",
              item.role === "user" ? "italic text-muted-foreground" : "chat-md"
            )}
          >
            {item.role === "user" ? (
              <p>» {item.text}</p>
            ) : (
              <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
            )}
            {item.streaming && (
              <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-primary/60" />
            )}
          </div>
        );
      })}
    </div>
  );
}
