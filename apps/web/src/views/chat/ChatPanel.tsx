import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Markdown from "react-markdown";
import {
  ArrowUp,
  BrainCircuit,
  Check,
  ClipboardList,
  Loader2,
  MessageSquareDashed,
  Paperclip,
  Sparkles,
  Square,
  X,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { ChatItemVm } from "@/types";
import type { AgentAction } from "@/state/sessions.store";
import type { EffortChoice, ModelChoice } from "@/hooks/useSessionsViewModel";

export interface ChatPanelProps {
  sessionTitle: string;
  items: ChatItemVm[];
  thinking: string;
  actions: AgentAction[];
  input: string;
  busy: boolean;
  connected: boolean;
  error: string | null;
  model: ModelChoice;
  effort: EffortChoice;
  planMode: boolean;
  attachments: string[];
  /** Currently selected file in the explorer, used by the attach button. */
  attachCandidate: string | null;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onCancel: () => void;
  onModelChange: (value: ModelChoice) => void;
  onEffortChange: (value: EffortChoice) => void;
  onPlanModeChange: (value: boolean) => void;
  onAttach: (path: string) => void;
  onRemoveAttachment: (path: string) => void;
}

export function ChatPanel(props: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [props.items, props.thinking, props.actions]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-4 py-2.5">
        <span
          className={cn(
            "orb relative h-7 w-7 shrink-0 rounded-full",
            props.busy && "orb-spin",
          )}
        >
          <span className="absolute inset-[3px] rounded-full bg-card/85 backdrop-blur" />
          <Sparkles className="absolute inset-0 m-auto h-3.5 w-3.5 text-primary" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {props.sessionTitle}
        </span>
        {props.busy && (
          <span className="text-shimmer text-xs font-semibold">
            agent working…
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-4 [scrollbar-gutter:stable_both-edges]"
      >
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-4">
          {props.items.length === 0 && !props.thinking && (
            <EmptyState connected={props.connected} />
          )}
          <AnimatePresence initial={false}>
            {props.items.map((item) => (
              <ChatMessage key={item.id} item={item} />
            ))}
            {props.busy && props.thinking && (
              <ThinkingBlock key="thinking" text={props.thinking} />
            )}
            {props.busy && (
              <ActivityFeed key="actions" actions={props.actions} />
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="px-4 pb-3">
        <div className="mx-auto w-full max-w-3xl">
          {props.error && (
            <motion.p
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {props.error}
            </motion.p>
          )}
          {props.attachments.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {props.attachments.map((path) => (
                <span
                  key={path}
                  className="flex items-center gap-1 rounded-lg bg-accent px-2 py-0.5 font-mono text-[11px] text-accent-foreground"
                >
                  <Paperclip className="h-3 w-3" />
                  {path}
                  <X
                    className="h-3 w-3 cursor-pointer hover:text-destructive"
                    onClick={() => props.onRemoveAttachment(path)}
                  />
                </span>
              ))}
            </div>
          )}
          <div
            className={cn(
              "rounded-2xl bg-muted/60 transition-colors",
              "focus-within:bg-muted",
            )}
          >
            <div className="flex items-end gap-2 p-2 pb-1">
              <textarea
                value={props.input}
                placeholder={
                  props.busy
                    ? "Agent is working — you can cancel or switch sessions"
                    : "Describe a task for this agent…"
                }
                disabled={!props.connected || props.busy}
                rows={1}
                onChange={(e) => {
                  props.onInputChange(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    props.onSend();
                  }
                }}
                className={cn(
                  "max-h-40 min-h-[36px] flex-1 resize-none bg-transparent px-2 py-1.5",
                  "text-sm outline-none placeholder:text-muted-foreground/70",
                  "disabled:opacity-60",
                )}
              />
              {props.busy ? (
                <motion.button
                  whileTap={{ scale: 0.92 }}
                  onClick={props.onCancel}
                  title="Cancel task"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-destructive text-white hover:opacity-90"
                >
                  <Square className="h-4 w-4 fill-current" />
                </motion.button>
              ) : (
                <motion.button
                  whileTap={{ scale: 0.92 }}
                  disabled={!props.connected || !props.input.trim()}
                  onClick={props.onSend}
                  title="Send (Enter)"
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                    "bg-primary text-primary-foreground transition-opacity",
                    "hover:opacity-90 disabled:opacity-30",
                  )}
                >
                  <ArrowUp className="h-4 w-4" />
                </motion.button>
              )}
            </div>
            <div className="flex items-center gap-2 px-3 pb-2 pt-0.5">
              <button
                title={
                  props.attachCandidate
                    ? `Attach ${props.attachCandidate}`
                    : "Select a file in the explorer to attach it"
                }
                disabled={!props.attachCandidate}
                onClick={() =>
                  props.attachCandidate && props.onAttach(props.attachCandidate)
                }
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-35"
              >
                <Paperclip className="h-3.5 w-3.5" />
              </button>
              <ComposerSelect
                value={props.model}
                onChange={(v) => props.onModelChange(v as ModelChoice)}
                options={[
                  ["default", "Model: default"],
                  ["opus", "Opus"],
                  ["sonnet", "Sonnet"],
                  ["haiku", "Haiku"],
                ]}
              />
              <ComposerSelect
                value={props.effort}
                onChange={(v) => props.onEffortChange(v as EffortChoice)}
                options={[
                  ["default", "Reasoning: default"],
                  ["low", "Low"],
                  ["medium", "Medium"],
                  ["high", "High"],
                  ["max", "Max"],
                ]}
              />
              <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground">
                <input
                  type="checkbox"
                  checked={props.planMode}
                  onChange={(e) => props.onPlanModeChange(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--primary)]"
                />
                <ClipboardList className="h-3.5 w-3.5" />
                Plan mode
              </label>
              <span className="ml-auto text-[10px] text-muted-foreground/50">
                Enter ↵ · Shift+Enter newline
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ComposerSelect(props: {
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <select
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      className={cn(
        "h-6 cursor-pointer rounded-md bg-muted/80 px-1.5 text-[11px]",
        "text-muted-foreground outline-none hover:text-foreground",
      )}
    >
      {props.options.map(([value, label]) => (
        <option key={value} value={value} className="bg-card text-foreground">
          {label}
        </option>
      ))}
    </select>
  );
}

/** Live feed: what the agent is doing right now (tools, files, commands). */
function ActivityFeed({ actions }: { actions: AgentAction[] }) {
  const recent = actions.slice(-6);
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="rounded-xl bg-muted/50 px-3 py-2"
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
        <span className="text-shimmer text-[11px] font-semibold uppercase tracking-wider">
          {recent.length > 0
            ? recent[recent.length - 1]!.status === "running"
              ? recent[recent.length - 1]!.label
              : "thinking…"
            : "thinking…"}
        </span>
      </div>
      {recent.length > 0 && (
        <div className="space-y-1">
          <AnimatePresence initial={false}>
            {recent.map((action) => (
              <motion.div
                key={action.id}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
              >
                {action.status === "running" ? (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary/70" />
                ) : action.status === "done" ? (
                  <Check className="h-3 w-3 shrink-0 text-success" />
                ) : (
                  <XCircle className="h-3 w-3 shrink-0 text-destructive" />
                )}
                <span className="truncate font-mono">{action.label}</span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  );
}

function ChatMessage({ item }: { item: ChatItemVm }) {
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
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground">
          <p className="whitespace-pre-wrap">{item.text}</p>
        </div>
      ) : (
        <div className="w-full max-w-full">
          <div className="mb-1 flex items-center gap-1.5">
            <Sparkles className="h-3 w-3 text-primary" />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Atelier
            </span>
          </div>
          <div className="chat-md rounded-2xl rounded-tl-md bg-muted/50 px-4 py-3">
            <Markdown>{item.text}</Markdown>
            {item.streaming && (
              <span className="ml-0.5 inline-block h-4 w-[7px] animate-pulse rounded-sm bg-primary/70 align-text-bottom" />
            )}
          </div>
        </div>
      )}
    </motion.div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
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
          thinking
        </span>
      </div>
      <p className="line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
        {text.slice(-600)}
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
