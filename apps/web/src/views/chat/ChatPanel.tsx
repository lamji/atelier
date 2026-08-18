import { memo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  MessageSquareDashed,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { liveHeadline } from "@/lib/live-headline";
import { useChatViewModel } from "@/hooks/useChatViewModel";
import { useStickToBottom } from "@/hooks/useStickToBottom";
import { ProcessCard } from "./ProcessCard";
import { Composer } from "./Composer";
import type { ChatItemVm } from "@/types";

export interface ChatPanelProps {
  /** Shell-level failure (creating a session), not a task failure. */
  shellError?: string | null;
}

/**
 * The chat surface: transcript in the centre and composer at the bottom.
 *
 * Reads its own data (see {@link useChatViewModel}) instead of taking it as
 * props, and is memoized on the one prop it does take — so a shell re-render
 * (a file event, an index tick, a usage refresh) cannot walk into the
 * transcript, and a keystroke stays inside {@link Composer}.
 */
export const ChatPanel = memo(function ChatPanel(props: ChatPanelProps) {
  const vm = useChatViewModel();

  // Follows the stream only while you're at the bottom; scroll up to read
  // and it stops yanking you back down. The process card lives in the stream
  // now, so its rows are one more thing that grows the scroll height.
  const { ref: scrollRef, onScroll } = useStickToBottom<HTMLDivElement>([
    vm.items,
    vm.thinking,
    vm.busy,
    vm.stage,
    vm.actions,
    vm.plan,
    vm.executions,
  ]);

  // The plan persists after a run so the turn's shape stays available; the
  // action rows only while it is live.
  // Any plan that exists is now a real one the model committed to via
  // set_plan. The old `> 1` test was working around the pipeline seeding a
  // one-step placeholder on every single turn — with that gone, a genuine
  // one-step plan is just a short task and deserves to show.
  const hasPlan = vm.plan !== null && vm.plan.steps.length > 0;
  const showProcess =
    vm.busy || hasPlan || vm.actions.length > 0 || vm.liveDiffs.length > 0;
  const workflowLogs = showProcess
    ? currentTurnLogs(vm.items, vm.activeTaskId)
    : [];
  const workflowLogIds = new Set(workflowLogs.map((item) => item.id));
  const timelineTaskIds = new Set(vm.executions.map((item) => item.taskId));
  if (vm.activeTaskId) timelineTaskIds.add(vm.activeTaskId);
  const activeRequest = vm.activeTaskId
    ? vm.items.find(
        (item) => item.taskId === vm.activeTaskId && item.role === "user"
      )
    : undefined;
  const status = vm.busy
    ? liveHeadline(vm.actions, vm.stage, vm.cancelling)
    : null;
  const activeExecution = vm.activeTaskId
    ? vm.executions.find((execution) => execution.taskId === vm.activeTaskId)
    : undefined;
  const error = props.shellError ?? vm.lastError;

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pb-3 pt-4">
        <div className="flex w-full items-center gap-3">
          <span
            className={cn(
              "orb relative h-9 w-9 shrink-0 rounded-xl",
              vm.busy && "orb-spin"
            )}
          >
            <span className="absolute inset-[3px] rounded-[0.6rem] bg-card/85 backdrop-blur" />
            <Sparkles className="absolute inset-0 m-auto h-4 w-4 text-primary" />
          </span>
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight">
            {vm.sessionTitle}
          </span>
          {vm.busy && (
            <span className="chip chip-accent">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
              <span className="text-shimmer font-semibold">working…</span>
            </span>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/*
            overflow-x-hidden is load-bearing: setting only overflow-y makes
            the other axis compute to auto, so one wide child puts a
            horizontal scrollbar under the whole transcript. Wide content
            (code blocks, tables) scrolls inside itself instead.
          */}
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 [scrollbar-gutter:stable_both-edges]"
          >
            <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-5">
              {vm.items.length === 0 && vm.executions.length === 0 && !vm.busy && (
                <EmptyState connected={vm.connected} />
              )}
              <AnimatePresence initial={false}>
                {/*
                  Diff payloads are not chat messages. The streaming assistant is
                  skipped while the run is live — ProcessCard carries the live
                  thinking state on the execution timeline.
                */}
                {vm.items.map((item) =>
                  item.role === "diff" ||
                  item.role === "log" ||
                  workflowLogIds.has(item.id) ||
                  (item.taskId !== undefined &&
                    timelineTaskIds.has(item.taskId) &&
                    (item.role === "user" || item.role === "assistant")) ||
                  (vm.busy && item.role === "assistant" && item.streaming) ? null : (
                    <ChatMessage key={item.id} item={item} />
                  )
                )}
                {vm.executions
                  .filter(
                    (execution) =>
                      execution.status !== "running" &&
                      execution.status !== "queued"
                  )
                  .map((execution) => (
                    <ProcessCard
                      key={execution.taskId}
                      request={execution.request}
                      report={execution.report}
                      images={execution.images ?? []}
                      frontendReview={execution.frontendReview}
                      requestedAt={execution.requestedAt}
                      plan={execution.plan}
                      busy={false}
                      actions={execution.actions}
                      diffs={execution.diffs}
                      stage={null}
                      startedAt={execution.startedAt}
                      durationMs={execution.durationMs}
                      cancelling={false}
                      logs={execution.logs}
                      thinking=""
                      status=""
                    />
                  ))}
                {showProcess && (
                  <ProcessCard
                    key="process"
                    request={activeRequest?.text ?? activeExecution?.request ?? ""}
                    report=""
                    images={activeExecution?.images ?? activeRequest?.images ?? []}
                    frontendReview={activeExecution?.frontendReview}
                    requestedAt={activeRequest?.createdAt ?? vm.taskStartedAt}
                    plan={hasPlan ? vm.plan : null}
                    busy={vm.busy}
                    actions={vm.actions}
                    diffs={vm.liveDiffs}
                    stage={vm.stage}
                    startedAt={vm.taskStartedAt}
                    cancelling={vm.cancelling}
                    logs={workflowLogs}
                    thinking={vm.thinking}
                    status={status ?? ""}
                  />
                )}
              </AnimatePresence>
            </div>
          </div>

          {error && (
            <div className="mx-auto w-full max-w-4xl px-4">
              <motion.p
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className={cn(
                  "mb-2 w-full rounded-2xl bg-destructive/10",
                  "px-4 py-2.5 text-xs text-destructive"
                )}
              >
                {error}
              </motion.p>
            </div>
          )}
          <Composer />
        </div>
      </div>
    </div>
  );
});

/** Logs emitted after the latest user request belong to its workflow card. */
function currentTurnLogs(
  items: ChatItemVm[],
  activeTaskId: string | null
): ChatItemVm[] {
  if (activeTaskId) {
    return items.filter(
      (item) => item.taskId === activeTaskId && item.role === "log"
    );
  }
  let latestUser = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.role === "user") {
      latestUser = index;
      break;
    }
  }
  return items.slice(latestUser + 1).filter((item) => item.role === "log");
}

const ChatMessage = memo(function ChatMessage({ item }: { item: ChatItemVm }) {
  const isUser = item.role === "user";
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className={cn("flex", isUser ? "justify-end" : "justify-start")}
    >
      {isUser ? (
        <div className="max-w-[78%] rounded-3xl rounded-br-lg bg-primary px-5 py-3 text-sm text-primary-foreground shadow-sm">
          {item.images && item.images.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {item.images.map((src, i) => (
                <img
                  key={i}
                  src={src}
                  alt="attachment"
                  className="max-h-40 rounded-lg border border-white/20 object-contain"
                />
              ))}
            </div>
          )}
          {item.text && <p className="whitespace-pre-wrap">{item.text}</p>}
        </div>
      ) : (
        <div className="w-full max-w-full">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="icon-tile icon-tile-sm">
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            <span className="text-[12px] font-semibold text-muted-foreground">
              Atelier
            </span>
          </div>
          <div className="chat-md rounded-3xl rounded-tl-lg bg-muted/60 px-4 py-3.5">
            <AssistantText text={item.text} streaming={item.streaming} />
          </div>
        </div>
      )}
    </motion.div>
  );
});

/**
 * Assistant body. While tokens are still arriving this stays plain text:
 * re-parsing the whole message through remark on every delta made long
 * answers stream slower the longer they got. The markdown render happens
 * once, when the message completes.
 */
function AssistantText({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  if (streaming) {
    return (
      <p className="whitespace-pre-wrap break-words text-sm">
        {text}
        <span className="ml-0.5 inline-block h-4 w-[7px] animate-pulse rounded-sm bg-primary/70 align-text-bottom" />
      </p>
    );
  }
  return <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>;
}

function EmptyState({ connected }: { connected: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex flex-1 flex-col items-center justify-center gap-3 py-10"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
        <MessageSquareDashed className="h-6 w-6 text-primary/70" />
      </div>
      <div className="text-center">
        <p className="text-sm font-medium">
          {connected ? "Start a task" : "Connecting to local agent…"}
        </p>
        <p className="mt-1 max-w-[240px] text-xs text-muted-foreground">
          {connected
            ? "This agent can read, search, and edit your workspace. Every action is shown live."
            : "Make sure the agent process is running."}
        </p>
      </div>
    </motion.div>
  );
}
