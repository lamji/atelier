import { memo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  BrainCircuit,
  FolderLock,
  History,
  MessageSquareDashed,
  Network,
  Radar,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { liveHeadline } from "@/lib/live-headline";
import { useChatViewModel } from "@/hooks/useChatViewModel";
import { useChangesRailViewModel } from "@/hooks/useChangesRailViewModel";
import { useStickToBottom } from "@/hooks/useStickToBottom";
import { ChangesRail } from "./ChangesRail";
import { ProcessCard } from "./ProcessCard";
import { Composer } from "./Composer";
import type { ChatItemVm } from "@/types";

export interface ChatPanelProps {
  /** Shell-level failure (creating a session), not a task failure. */
  shellError?: string | null;
}

/**
 * The chat surface: transcript in the centre, changes rail on the right,
 * composer at the bottom.
 *
 * The turn reads left to right, once each: the conversation and the process
 * card in the stream, every file the agent touched in the rail beside it.
 * A diff is never rendered twice.
 *
 * Reads its own data (see {@link useChatViewModel}) instead of taking it as
 * props, and is memoized on the one prop it does take — so a shell re-render
 * (a file event, an index tick, a usage refresh) cannot walk into the
 * transcript, and a keystroke stays inside {@link Composer}.
 */
export const ChatPanel = memo(function ChatPanel(props: ChatPanelProps) {
  const vm = useChatViewModel();
  const changes = useChangesRailViewModel(vm.items, vm.liveDiffs);

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
  ]);

  // The plan persists after a run so the turn's shape stays available; the
  // action rows only while it is live.
  // Any plan that exists is now a real one the model committed to via
  // set_plan. The old `> 1` test was working around the pipeline seeding a
  // one-step placeholder on every single turn — with that gone, a genuine
  // one-step plan is just a short task and deserves to show.
  const hasPlan = vm.plan !== null && vm.plan.steps.length > 0;
  const showProcess = vm.busy || hasPlan;
  const status = vm.busy
    ? liveHeadline(vm.actions, vm.stage, vm.cancelling)
    : null;
  const error = props.shellError ?? vm.lastError;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-4 py-2.5">
        <span
          className={cn(
            "orb relative h-7 w-7 shrink-0 rounded-full",
            vm.busy && "orb-spin"
          )}
        >
          <span className="absolute inset-[3px] rounded-full bg-card/85 backdrop-blur" />
          <Sparkles className="absolute inset-0 m-auto h-3.5 w-3.5 text-primary" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {vm.sessionTitle}
        </span>
        {vm.busy && (
          <span className="text-shimmer text-xs font-semibold">
            agent working…
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {/*
          min-w-0: a flex item's default min-width is its content, so without
          it a wide code block in the transcript refuses to shrink, the row
          grows past the window, and the rail is pushed off the right edge.
          This column is the one that gives — the rail's width is fixed.
        */}
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
            <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-4">
              {vm.items.length === 0 && !vm.busy && (
                <EmptyState connected={vm.connected} />
              )}
              <AnimatePresence initial={false}>
                {/*
                  Diff items are skipped: every edit in this conversation is
                  in the rail, one tab per file. The streaming assistant is
                  skipped while the run is live — ThinkingBlock carries it.
                */}
                {vm.items.map((item) =>
                  item.role === "diff" ||
                  (vm.busy && item.role === "assistant" && item.streaming) ? null : (
                    <ChatMessage key={item.id} item={item} />
                  )
                )}
                {showProcess && (
                  <ProcessCard
                    key="process"
                    plan={hasPlan ? vm.plan : null}
                    busy={vm.busy}
                    actions={vm.actions}
                    stage={vm.stage}
                    startedAt={vm.taskStartedAt}
                    cancelling={vm.cancelling}
                  />
                )}
                {vm.busy && (
                  <ThinkingBlock
                    key="thinking"
                    text={vm.thinking}
                    status={status ?? ""}
                  />
                )}
              </AnimatePresence>
            </div>
          </div>

          {error && (
            <div className="px-4">
              <motion.p
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className={cn(
                  "mx-auto mb-2 w-full max-w-3xl rounded-lg bg-destructive/10",
                  "px-3 py-2 text-xs text-destructive"
                )}
              >
                {error}
              </motion.p>
            </div>
          )}
          <Composer />
        </div>

        {/* Always mounted, never animated. A 420px column that arrives with
            the first edit reflows the transcript at exactly the frame the
            edit lands in, and framer-motion's layout projection on the
            messages does not survive that. Holding the width from the start
            costs the transcript nothing it wasn't going to give up anyway,
            and the empty state carries the current step until a diff lands. */}
        <ChangesRail vm={changes} status={status} />
      </div>
    </div>
  );
});

const ChatMessage = memo(function ChatMessage({ item }: { item: ChatItemVm }) {
  const isUser = item.role === "user";
  if (item.role === "log") return <LogLine item={item} />;
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className={cn("flex", isUser ? "justify-end" : "justify-start")}
    >
      {isUser ? (
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground">
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
          <div className="mb-1 flex items-center gap-1.5">
            <Sparkles className="h-3 w-3 text-primary" />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Atelier
            </span>
          </div>
          <div className="chat-md rounded-2xl rounded-tl-md border border-border/50 bg-muted/40 px-4 py-3">
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

/** Icon for a pinned knowledge/impact log line, by its source topic. */
function logIcon(topic: string | undefined) {
  if (topic === "knowledge.retrieved") return Network;
  if (topic === "session.recalled") return History;
  if (topic === "scope.locked") return FolderLock;
  return Radar;
}

/** Knowledge / session recall / impact radius, pinned inline in the transcript. */
const LogLine = memo(function LogLine({ item }: { item: ChatItemVm }) {
  const Icon = logIcon(item.logTopic);
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="flex items-start gap-1.5 rounded-lg bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground"
    >
      <Icon className="mt-0.5 h-3 w-3 shrink-0 text-primary/70" />
      <span className="min-w-0 flex-1 truncate">{item.text}</span>
    </motion.div>
  );
});

/**
 * The centre's live block. Present for the WHOLE run, not only while the
 * model happens to be emitting thought: the transcript goes quiet during
 * retrieval, planning, and long tool stretches, and a blank centre next to
 * a ticking process card reads as a stall. Thinking text wins when there
 * is any; otherwise the block carries the current step.
 */
function ThinkingBlock({ text, status }: { text: string; status: string }) {
  const thinking = text.trim().length > 0;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="rounded-xl bg-primary/[0.06] px-3 py-2"
    >
      <div className="mb-1 flex items-center gap-1.5">
        <BrainCircuit className="h-3.5 w-3.5 animate-pulse text-primary/70" />
        <span className="text-[11px] font-medium uppercase tracking-wider text-primary/70">
          {thinking ? "thinking" : "working"}
        </span>
      </div>
      <p
        className={cn(
          "whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground",
          "text-shimmer truncate"
        )}
      >
        {thinking ? text : status}
      </p>
    </motion.div>
  );
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
