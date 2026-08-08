import { memo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MonacoDiff } from "@/components/MonacoDiff";
import {
  BrainCircuit,
  Check,
  ClipboardList,
  FileDiff,
  FolderLock,
  History,
  Loader2,
  MessageSquareDashed,
  Network,
  Radar,
  Sparkles,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { STAGE_LABELS } from "@/lib/stage-labels";
import {
  diffHeight,
  INLINE_DIFF_EDITOR_OPTIONS,
  languageForPath,
  lineStat,
} from "@/lib/diff-view";
import { useChatViewModel } from "@/hooks/useChatViewModel";
import { useElapsed } from "@/hooks/useElapsed";
import { useStickToBottom } from "@/hooks/useStickToBottom";
import { Tooltip } from "@/components/ui/tooltip";
import { Composer } from "./Composer";
import type { ChatItemVm } from "@/types";
import type { PipelineStage, Plan, PlanStep } from "@atelier/protocol";
import type { AgentAction, LiveDiff } from "@/state/sessions.store";

export interface ChatPanelProps {
  /** Shell-level failure (creating a session), not a task failure. */
  shellError?: string | null;
}

/** Drag-resize bounds for the process rail (plan + activity + diffs). */
const PROCESS_MIN_WIDTH = 260;
const PROCESS_MAX_WIDTH = 720;

/**
 * The chat surface: transcript in the centre, live process rail on the
 * right, composer at the bottom.
 *
 * Reads its own data (see {@link useChatViewModel}) instead of taking it as
 * props, and is memoized on the one prop it does take — so a shell re-render
 * (a file event, an index tick, a usage refresh) cannot walk into the
 * transcript, and a keystroke stays inside {@link Composer}.
 */
export const ChatPanel = memo(function ChatPanel(props: ChatPanelProps) {
  const vm = useChatViewModel();
  const [processWidth, setProcessWidth] = useState(320);
  const [resizingProcess, setResizingProcess] = useState(false);

  // Follows the stream only while you're at the bottom; scroll up to read
  // and it stops yanking you back down. The center only carries the summary
  // now, so it no longer jumps when the process rail ticks.
  const { ref: scrollRef, onScroll } = useStickToBottom<HTMLDivElement>([
    vm.items,
    vm.thinking,
    // The live block is part of the centre's stream: it appears when the
    // run starts and its status line moves with the stage.
    vm.busy,
    vm.stage,
  ]);

  // The process rail (plan + activity + diffs) auto-follows its own stream.
  const { ref: procRef, onScroll: onProcScroll } =
    useStickToBottom<HTMLDivElement>([vm.actions, vm.liveDiffs, vm.plan]);

  // Diffs from the running task render inside the live feed (near the edit
  // that produced them), so hide their transcript copies until the run ends.
  const liveDiffIds = new Set(vm.liveDiffs.map((d) => d.id));

  // The right rail holds the process: the live plan persists after a run so
  // it stays available; the activity feed shows only while the task runs.
  const hasPlan = vm.plan !== null && vm.plan.steps.length > 1;
  const showProcess = vm.busy || hasPlan;
  const error = props.shellError ?? vm.lastError;

  /** Drag the rail's left edge to widen it — handy for reading a wide diff. */
  const onProcessResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = processWidth;
    setResizingProcess(true);
    const onMove = (ev: PointerEvent) => {
      const next = startWidth + (startX - ev.clientX);
      setProcessWidth(
        Math.min(PROCESS_MAX_WIDTH, Math.max(PROCESS_MIN_WIDTH, next))
      );
    };
    const onUp = () => {
      setResizingProcess(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

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
        <div className="flex min-h-0 flex-1 flex-col">
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
                {vm.items.map((item) =>
                  liveDiffIds.has(item.id) ||
                  (vm.busy && item.role === "assistant" && item.streaming) ? null : (
                    <ChatMessage
                      key={item.id}
                      item={item}
                      monacoTheme={vm.monacoTheme}
                    />
                  )
                )}
                {vm.busy && (
                  <ThinkingBlock
                    key="thinking"
                    text={vm.thinking}
                    status={liveHeadline(vm.actions, vm.stage, vm.cancelling)}
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

        <AnimatePresence>
          {showProcess && (
            <ProcessPanel
              scrollRef={procRef}
              onScroll={onProcScroll}
              plan={hasPlan ? vm.plan : null}
              busy={vm.busy}
              actions={vm.actions}
              diffs={vm.liveDiffs}
              stage={vm.stage}
              startedAt={vm.taskStartedAt}
              cancelling={vm.cancelling}
              monacoTheme={vm.monacoTheme}
              width={processWidth}
              resizing={resizingProcess}
              onResizeStart={onProcessResizeStart}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
});

/**
 * Right-side rail that carries the *process* — the live plan, the activity
 * feed, and this run's diffs. Splitting it out keeps the model's summary
 * pinned in the center so it can be tracked without scrolling the transcript.
 */
function ProcessPanel(props: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  plan: Plan | null;
  busy: boolean;
  actions: AgentAction[];
  diffs: LiveDiff[];
  stage: PipelineStage | null;
  startedAt: number | null;
  cancelling: boolean;
  monacoTheme: string;
  width: number;
  resizing: boolean;
  onResizeStart: (e: React.PointerEvent) => void;
}) {
  return (
    <motion.aside
      initial={{ opacity: 0, width: 0 }}
      animate={{ opacity: 1, width: props.width }}
      exit={{ opacity: 0, width: 0 }}
      transition={{
        opacity: { duration: 0.2 },
        width: props.resizing
          ? { duration: 0 }
          : { type: "spring", stiffness: 260, damping: 30 },
      }}
      className="relative flex shrink-0 overflow-hidden border-l border-white/10"
    >
      {/* Drag handle: widen the rail to read a diff without cropping it. */}
      <div
        onPointerDown={props.onResizeStart}
        className="absolute inset-y-0 left-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize touch-none hover:bg-primary/40"
      />
      <div
        ref={props.scrollRef}
        onScroll={props.onScroll}
        style={{ width: props.width }}
        className={cn(
          "flex h-full flex-col gap-3 overflow-y-auto",
          "px-3 py-4 [scrollbar-gutter:stable]"
        )}
      >
        <div className="flex items-center gap-1.5 px-1">
          <Radar className="h-3.5 w-3.5 text-primary/70" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Process
          </span>
        </div>
        {props.plan && <PlanCard plan={props.plan} />}
        {props.busy && (
          <ActivityFeed
            actions={props.actions}
            diffs={props.diffs}
            stage={props.stage}
            startedAt={props.startedAt}
            cancelling={props.cancelling}
            monacoTheme={props.monacoTheme}
          />
        )}
      </div>
    </motion.aside>
  );
}

/** The live task plan checklist (pipeline stage 4, updated by the model). */
const PlanCard = memo(function PlanCard({ plan }: { plan: Plan }) {
  const done = plan.steps.filter((s) => s.status === "done").length;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="rounded-xl bg-muted/50 px-3 py-2"
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <ClipboardList className="h-3.5 w-3.5 text-primary" />
        <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Plan · {done}/{plan.steps.length}
        </span>
      </div>
      <div className="space-y-1">
        {plan.steps.map((step) => (
          <Tooltip key={step.id} content={step.detail} disabled={!step.detail}>
            <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <PlanStepIcon status={step.status} />
              <span
                className={cn(
                  "min-w-0 flex-1",
                  step.status === "done" && "line-through opacity-60",
                  step.status === "in-progress" && "text-foreground"
                )}
              >
                <span className="block break-words">{step.title}</span>
                {/*
                 * Same treatment as the action rail: these are file paths
                 * with no spaces to break at, so min-w-0 alone does not
                 * hold them — the flex item stops stretching but the text
                 * still runs past the card. break-all is what wraps them.
                 * Their own line, because a path reads as one unit rather
                 * than a tail on the sentence above it.
                 */}
                {step.files.length > 0 && (
                  <span className="mt-0.5 block break-all font-mono text-[10px] opacity-60">
                    {step.files.join(", ")}
                  </span>
                )}
              </span>
            </div>
          </Tooltip>
        ))}
      </div>
    </motion.div>
  );
});

function PlanStepIcon({ status }: { status: PlanStep["status"] }) {
  if (status === "done") {
    return <Check className="mt-0.5 h-3 w-3 shrink-0 text-success" />;
  }
  if (status === "in-progress") {
    return (
      <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-primary" />
    );
  }
  if (status === "failed" || status === "cancelled") {
    return <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />;
  }
  return (
    <span className="mt-1 ml-0.5 mr-0.5 h-2 w-2 shrink-0 rounded-full border border-muted-foreground/40" />
  );
}

/**
 * Live progress while a task runs. The header always moves — stage, then
 * the current tool — so long stretches between the model's own messages
 * never read as a stall.
 */
const ActivityFeed = memo(function ActivityFeed({
  actions,
  diffs,
  stage,
  startedAt,
  cancelling,
  monacoTheme,
}: {
  actions: AgentAction[];
  diffs: LiveDiff[];
  stage: PipelineStage | null;
  startedAt: number | null;
  cancelling: boolean;
  monacoTheme: string;
}) {
  const recent = actions.slice(-6);
  const elapsed = useElapsed(startedAt);
  const running = recent.find((a) => a.status === "running");
  const headline = liveHeadline(actions, stage, cancelling);

  // One chronological stream: the recent actions plus every diff from this
  // run (a diff is the record of an edit — never drop it, even after its
  // action scrolls out of the window), ordered by the shared feed clock so
  // each diff lands right under the "Editing" action that produced it.
  const rows = [
    ...recent.map((a) => ({ kind: "action" as const, seq: a.seq, action: a })),
    ...diffs.map((d) => ({ kind: "diff" as const, seq: d.seq, diff: d })),
  ].sort((a, b) => a.seq - b.seq);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="rounded-xl bg-muted/50 px-3 py-2"
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
        <span className="text-shimmer min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider">
          {headline}
        </span>
        {startedAt !== null && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
          </span>
        )}
      </div>
      {stage && running && (
        <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">
          {STAGE_LABELS[stage]}
        </p>
      )}
      {rows.length > 0 && (
        <div className="space-y-1.5">
          <AnimatePresence initial={false}>
            {rows.map((row) =>
              row.kind === "action" ? (
                <motion.div
                  key={row.action.id}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="flex items-start gap-1.5 text-[11px] text-muted-foreground"
                >
                  {row.action.status === "running" ? (
                    <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-primary/70" />
                  ) : row.action.status === "done" ? (
                    <Check className="mt-0.5 h-3 w-3 shrink-0 text-success" />
                  ) : (
                    <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
                  )}
                  {/*
                   * Wrap instead of truncate: these labels are file paths, and
                   * the part that identifies the file is the tail — exactly
                   * what an ellipsis eats. break-all keeps long unbroken paths
                   * inside the rail instead of stretching it.
                   */}
                  <span className="min-w-0 flex-1">
                    <span className="block break-all font-mono">
                      {row.action.label}
                    </span>
                    {row.action.status === "failed" && row.action.error && (
                      <span className="mt-0.5 block break-all font-mono text-[10px] text-destructive">
                        {row.action.error}
                      </span>
                    )}
                  </span>
                </motion.div>
              ) : (
                <DiffCard
                  key={row.diff.id}
                  diff={row.diff}
                  monacoTheme={monacoTheme}
                  defaultOpen
                />
              )
            )}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  );
});

const ChatMessage = memo(function ChatMessage({
  item,
  monacoTheme,
}: {
  item: ChatItemVm;
  monacoTheme: string;
}) {
  const isUser = item.role === "user";
  if (item.role === "log") return <LogLine item={item} />;
  if (item.role === "diff") {
    return <DiffMessage item={item} monacoTheme={monacoTheme} />;
  }
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
 * A file edit, shown inline in the transcript as a VS Code-style diff:
 * just the path and the change, themed to match the app's dark/light mode.
 */
const DiffMessage = memo(function DiffMessage({
  item,
  monacoTheme,
}: {
  item: ChatItemVm;
  monacoTheme: string;
}) {
  if (!item.diff) return null;
  return <DiffCard diff={item.diff} monacoTheme={monacoTheme} />;
});

/**
 * The diff card itself — path header, +/− line stat, and the Monaco diff.
 * Shared by the transcript ({@link DiffMessage}) and the live activity feed,
 * so an edit looks the same whether it's happening now or scrolled-back history.
 *
 * Monaco is mounted lazily, on demand: a long session can produce dozens of
 * edits, and dozens of live diff editors is what turned scrolling the
 * transcript into a slideshow. Collapsed cards render the stat line only.
 */
const DiffCard = memo(function DiffCard({
  diff,
  monacoTheme,
  defaultOpen = false,
}: {
  diff: NonNullable<ChatItemVm["diff"]>;
  monacoTheme: string;
  /** The live feed opens its diffs; scrolled-back history starts collapsed. */
  defaultOpen?: boolean;
}) {
  const { added, removed } = lineStat(diff.before, diff.after);
  const [open, setOpen] = useState(defaultOpen);
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="w-full max-w-full"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <FileDiff className="h-3.5 w-3.5 shrink-0 text-primary/70" />
        <span className="truncate font-mono text-xs font-medium">
          {diff.path}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums">
          {added > 0 && <span className="text-success">+{added}</span>}
          {removed > 0 && <span className="text-destructive">−{removed}</span>}
        </span>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/60">
          {open ? "hide" : "show"}
        </span>
      </button>
      {open && (
        <div
          className="mt-2 overflow-hidden rounded-xl border border-white/10"
          style={{ height: diffHeight(diff.before, diff.after) }}
        >
          <MonacoDiff
            original={diff.before}
            modified={diff.after}
            language={languageForPath(diff.path)}
            theme={monacoTheme}
            options={INLINE_DIFF_EDITOR_OPTIONS}
          />
        </div>
      )}
    </motion.div>
  );
});

/**
 * What the agent is doing right now, in one line: the running tool, else
 * the pipeline stage. Shared by the process rail and the centre's live
 * block so the two never disagree about the current step.
 */
function liveHeadline(
  actions: AgentAction[],
  stage: PipelineStage | null,
  cancelling: boolean
): string {
  if (cancelling) return "stopping — finishing the current step";
  const running = actions.slice(-6).find((a) => a.status === "running");
  return running?.label ?? (stage ? STAGE_LABELS[stage] : "starting…");
}

/**
 * The centre's live block. Present for the WHOLE run, not only while the
 * model happens to be emitting thought: the transcript goes quiet during
 * retrieval, planning, and long tool stretches, and a blank centre next to
 * a ticking process rail reads as a stall. Thinking text wins when there
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
