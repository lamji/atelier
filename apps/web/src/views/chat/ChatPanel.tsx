import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Markdown from "react-markdown";
import {
  ArrowUp,
  BrainCircuit,
  Check,
  ClipboardList,
  FileCode2,
  ImagePlus,
  Loader2,
  MessageSquareDashed,
  Paperclip,
  Sparkles,
  Square,
  X,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { STAGE_LABELS } from "@/lib/stage-labels";
import { useElapsed } from "@/hooks/useElapsed";
import { useStickToBottom } from "@/hooks/useStickToBottom";
import { Select } from "@/components/ui/select";
import type { ChatItemVm } from "@/types";
import type {
  ModelOption,
  PipelineStage,
  Plan,
  PlanStep,
} from "@atelier/protocol";
import type { AgentAction } from "@/state/sessions.store";
import type {
  EffortChoice,
  ModelChoice,
  PendingImage,
} from "@/hooks/useSessionsViewModel";
import type { SlashCommand } from "@atelier/protocol";

export interface ChatPanelProps {
  sessionTitle: string;
  items: ChatItemVm[];
  thinking: string;
  actions: AgentAction[];
  /** Live task plan (pipeline stage 4); null before planning. */
  plan: Plan | null;
  /** Pipeline stage the running task is in; null before the first stage. */
  stage: PipelineStage | null;
  /** Start of the running task, for the elapsed counter. */
  taskStartedAt: number | null;
  /** A stop was requested and the task has not ended yet. */
  cancelling: boolean;
  input: string;
  busy: boolean;
  connected: boolean;
  error: string | null;
  model: ModelChoice;
  /** Live model roster from the SDK; falls back to a built-in list. */
  models: ModelOption[];
  effort: EffortChoice;
  planMode: boolean;
  attachments: string[];
  /** Images staged in the composer (screenshots), with data-URL previews. */
  images: PendingImage[];
  /** Currently selected file in the explorer, used by the attach button. */
  attachCandidate: string | null;
  /** Commands + skills offered by the "/" autocomplete menu. */
  slashCommands: SlashCommand[];
  /** Workspace file paths offered by the "@" mention menu. */
  filePaths: string[];
  onInputChange: (value: string) => void;
  onSend: () => void;
  onCancel: () => void;
  onModelChange: (value: ModelChoice) => void;
  onEffortChange: (value: EffortChoice) => void;
  onPlanModeChange: (value: boolean) => void;
  onAttach: (path: string) => void;
  onRemoveAttachment: (path: string) => void;
  onAddImages: (files: File[] | FileList) => void;
  onRemoveImage: (id: string) => void;
}

/** Composer grows with the text up to this height, then scrolls. */
const MAX_COMPOSER_HEIGHT = 160;

/** Used only when the SDK model probe fails (offline / older agent). */
const FALLBACK_MODELS: Array<[string, string]> = [
  ["default", "Default"],
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"],
];

/** Model picker options from the live SDK roster, else the fallback. */
function modelOptions(models: ModelOption[]): Array<[string, string]> {
  if (models.length === 0) return FALLBACK_MODELS;
  return models.map((m) => [m.value, m.label]);
}

export function ChatPanel(props: ChatPanelProps) {
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);

  // Follows the stream only while you're at the bottom; scroll up to read
  // and it stops yanking you back down.
  const { ref: scrollRef, onScroll } = useStickToBottom<HTMLDivElement>([
    props.items,
    props.thinking,
    props.actions,
  ]);

  /**
   * Auto-size the composer from the value, not from keystrokes: sending,
   * picking a slash command, or switching sessions clears the input
   * without a change event, and the box must shrink back with it.
   */
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
  }, [props.input]);

  // "/" menu is live while the first token is being typed, like Claude Code.
  const slashQuery =
    props.input.startsWith("/") && !/\s/.test(props.input)
      ? props.input.slice(1).toLowerCase()
      : null;
  const slashMatches =
    slashQuery !== null && !slashDismissed
      ? props.slashCommands
          .filter((c) => c.name.toLowerCase().includes(slashQuery))
          .slice(0, 12)
      : [];
  const slashOpen = slashMatches.length > 0;

  // "@" mention: the token being typed at the caret (mid-sentence too).
  const mention = mentionDismissed ? null : activeMention(props.input, caret);
  const mentionMatches = mention
    ? filterFiles(props.filePaths, mention.query)
    : [];
  const mentionOpen = mentionMatches.length > 0;

  const changeInput = (value: string) => {
    props.onInputChange(value);
    setSlashDismissed(false);
    setSlashIndex(0);
    setMentionDismissed(false);
    setMentionIndex(0);
    // Caret sits just after the inserted text on a change event.
    setCaret(value.length - (props.input.length - caret));
  };

  const syncCaret = () => {
    const el = composerRef.current;
    if (el) setCaret(el.selectionStart ?? el.value.length);
  };

  const pickSlash = (command: SlashCommand) => {
    props.onInputChange(`/${command.name} `);
    setSlashDismissed(true);
  };

  /**
   * Stage files pasted into the composer (screenshots land here). All files
   * go to onAddImages, which filters and reports anything it skips — a plain
   * text paste carries no files, so typing is untouched.
   */
  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      e.preventDefault();
      props.onAddImages(files);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      e.preventDefault();
      props.onAddImages(files);
    }
  };

  /** Replaces the active "@token" with the bare file path (no contents). */
  const pickMention = (filePath: string) => {
    if (!mention) return;
    const before = props.input.slice(0, mention.start);
    const after = props.input.slice(mention.end);
    const next = `${before}${filePath} ${after}`;
    props.onInputChange(next);
    setMentionDismissed(true);
    const pos = before.length + filePath.length + 1;
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
        setCaret(pos);
      }
    });
  };

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setMentionIndex(
          (i) => (i + delta + mentionMatches.length) % mentionMatches.length
        );
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        const chosen = mentionMatches[mentionIndex] ?? mentionMatches[0];
        if (chosen) pickMention(chosen);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionDismissed(true);
        return;
      }
    }
    if (slashOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setSlashIndex(
          (i) => (i + delta + slashMatches.length) % slashMatches.length
        );
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        const chosen = slashMatches[slashIndex] ?? slashMatches[0];
        if (chosen) pickSlash(chosen);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      props.onSend();
    }
  };

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
        onScroll={onScroll}
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
            {props.plan && props.plan.steps.length > 1 && (
              <PlanCard key="plan" plan={props.plan} />
            )}
            {props.busy && (
              <ActivityFeed
                key="actions"
                actions={props.actions}
                stage={props.stage}
                startedAt={props.taskStartedAt}
                cancelling={props.cancelling}
              />
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
          {props.images.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-2">
              {props.images.map((img) => (
                <div key={img.id} className="group relative">
                  <img
                    src={img.dataUrl}
                    alt="attachment"
                    className="h-16 w-16 rounded-lg border border-white/10 object-cover"
                  />
                  <button
                    onClick={() => props.onRemoveImage(img.id)}
                    title="Remove image"
                    className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-white opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div
            className="relative"
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("Files")) {
                e.preventDefault();
                setDragging(true);
              }
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) props.onAddImages(e.target.files);
                e.target.value = "";
              }}
            />
            <AnimatePresence>
              {slashOpen && (
                <SlashMenu
                  matches={slashMatches}
                  selectedIndex={slashIndex}
                  onHover={setSlashIndex}
                  onPick={pickSlash}
                />
              )}
              {mentionOpen && !slashOpen && (
                <MentionMenu
                  matches={mentionMatches}
                  selectedIndex={mentionIndex}
                  query={mention?.query ?? ""}
                  onHover={setMentionIndex}
                  onPick={pickMention}
                />
              )}
            </AnimatePresence>
          <div
            className={cn(
              "rounded-2xl bg-muted/60 transition-colors",
              "focus-within:bg-muted",
              dragging && "ring-2 ring-primary/60",
            )}
          >
            {dragging && (
              <div className="pointer-events-none flex items-center justify-center gap-2 py-1 text-[11px] font-medium text-primary">
                <ImagePlus className="h-3.5 w-3.5" />
                Drop image to attach
              </div>
            )}
            <div className="flex items-end gap-2 p-2 pb-1">
              <textarea
                ref={composerRef}
                value={props.input}
                placeholder={
                  props.busy
                    ? "Agent is working — you can cancel or switch sessions"
                    : "Describe a task, paste or drop a screenshot…"
                }
                disabled={!props.connected || props.busy}
                rows={1}
                onChange={(e) => changeInput(e.target.value)}
                onKeyDown={onComposerKeyDown}
                onKeyUp={syncCaret}
                onClick={syncCaret}
                onSelect={syncCaret}
                onPaste={onPaste}
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
                  disabled={props.cancelling}
                  title={
                    props.cancelling
                      ? "Stopping — finishing the current step"
                      : "Cancel task"
                  }
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                    "text-white hover:opacity-90",
                    props.cancelling
                      ? "bg-destructive/60"
                      : "bg-destructive"
                  )}
                >
                  {props.cancelling ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Square className="h-4 w-4 fill-current" />
                  )}
                </motion.button>
              ) : (
                <motion.button
                  whileTap={{ scale: 0.92 }}
                  disabled={
                    !props.connected ||
                    (!props.input.trim() && props.images.length === 0)
                  }
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
                type="button"
                title="Attach an image (or paste / drop a screenshot)"
                disabled={!props.connected || props.busy}
                onClick={() => fileInputRef.current?.click()}
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-35"
              >
                <Paperclip className="h-3.5 w-3.5" />
              </button>
              <ComposerSelect
                value={props.model}
                onChange={(v) => props.onModelChange(v as ModelChoice)}
                options={modelOptions(props.models)}
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
    </div>
  );
}

/**
 * Claude Code-style "/" autocomplete: commands and skills discovered
 * from ~/.claude and the workspace's .claude directory.
 */
function SlashMenu(props: {
  matches: SlashCommand[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onPick: (command: SlashCommand) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);

  // Keep the keyboard-selected row in view.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [props.selectedIndex]);

  return (
    <motion.ul
      ref={listRef}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.12 }}
      className={cn(
        "absolute bottom-full left-0 right-0 z-40 mb-2 max-h-64",
        "overflow-y-auto rounded-xl border border-white/10 bg-card p-1 shadow-xl"
      )}
    >
      {props.matches.map((command, index) => (
        <li key={`${command.scope}:${command.name}`}>
          <button
            type="button"
            data-selected={index === props.selectedIndex}
            // preventDefault keeps focus in the textarea while clicking.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => props.onPick(command)}
            onMouseEnter={() => props.onHover(index)}
            className={cn(
              "flex w-full items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left",
              index === props.selectedIndex && "bg-accent/60"
            )}
          >
            <span className="shrink-0 font-mono text-xs text-primary">
              /{command.name}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
              {command.description}
            </span>
            <span
              className={cn(
                "shrink-0 rounded px-1 py-px text-[9px] uppercase tracking-wide",
                command.kind === "skill"
                  ? "bg-primary/15 text-primary"
                  : "bg-muted text-muted-foreground"
              )}
            >
              {command.kind === "skill" ? "skill" : command.scope}
            </span>
          </button>
        </li>
      ))}
    </motion.ul>
  );
}

interface ActiveMention {
  query: string;
  start: number;
  end: number;
}

/**
 * The "@…" token under the caret, if any. A mention starts at an "@" that
 * sits at the start of the input or right after whitespace, and runs to
 * the caret with no whitespace in between — so it fires mid-sentence too.
 */
function activeMention(input: string, caret: number): ActiveMention | null {
  const upto = input.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at < 0) return null;
  const before = at === 0 ? "" : upto[at - 1];
  if (before && !/\s/.test(before)) return null;
  const query = upto.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { query, start: at, end: caret };
}

const MAX_MENTION_RESULTS = 10;

/**
 * Ranks file paths for the "@" menu: basename prefix matches first, then
 * basename/path substring matches. Case-insensitive, space-insensitive.
 */
function filterFiles(files: string[], query: string): string[] {
  const q = query.toLowerCase().trim();
  if (files.length === 0) return [];
  if (q === "") return files.slice(0, MAX_MENTION_RESULTS);
  const scored: Array<{ path: string; score: number }> = [];
  for (const path of files) {
    const lower = path.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    let score = -1;
    if (base.startsWith(q)) score = 0;
    else if (base.includes(q)) score = 1;
    else if (lower.includes(q)) score = 2;
    if (score >= 0) scored.push({ path, score });
    if (scored.length > 400) break;
  }
  scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length);
  return scored.slice(0, MAX_MENTION_RESULTS).map((s) => s.path);
}

/** Workspace file picker for "@" mentions — inserts a path, not contents. */
function MentionMenu(props: {
  matches: string[];
  selectedIndex: number;
  query: string;
  onHover: (index: number) => void;
  onPick: (path: string) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [props.selectedIndex]);

  return (
    <motion.ul
      ref={listRef}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.12 }}
      className={cn(
        "absolute bottom-full left-0 right-0 z-40 mb-2 max-h-64",
        "overflow-y-auto rounded-xl border border-white/10 bg-card p-1 shadow-xl"
      )}
    >
      {props.matches.map((path, index) => {
        const slash = path.lastIndexOf("/");
        const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
        const name = slash >= 0 ? path.slice(slash + 1) : path;
        return (
          <li key={path}>
            <button
              type="button"
              data-selected={index === props.selectedIndex}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => props.onPick(path)}
              onMouseEnter={() => props.onHover(index)}
              className={cn(
                "flex w-full items-baseline gap-1.5 rounded-lg px-2.5 py-1.5 text-left",
                index === props.selectedIndex && "bg-accent/60"
              )}
            >
              <FileCode2 className="h-3.5 w-3.5 shrink-0 self-center text-primary/70" />
              <span className="shrink-0 font-mono text-xs">{name}</span>
              <span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-muted-foreground/60">
                {dir}
              </span>
            </button>
          </li>
        );
      })}
    </motion.ul>
  );
}

function ComposerSelect(props: {
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <Select
      value={props.value}
      onChange={props.onChange}
      direction="up"
      options={props.options.map(([value, label]) => ({ value, label }))}
    />
  );
}

/** The live task plan checklist (pipeline stage 4, updated by the model). */
function PlanCard({ plan }: { plan: Plan }) {
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
          <div
            key={step.id}
            className="flex items-start gap-1.5 text-[11px] text-muted-foreground"
            title={step.detail}
          >
            <PlanStepIcon status={step.status} />
            <span
              className={cn(
                "min-w-0 flex-1",
                step.status === "done" && "line-through opacity-60",
                step.status === "in-progress" && "text-foreground"
              )}
            >
              {step.title}
              {step.files.length > 0 && (
                <span className="ml-1 font-mono text-[10px] opacity-60">
                  {step.files.join(", ")}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

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

/** Live feed: what the agent is doing right now (tools, files, commands). */
/**
 * Live progress while a task runs. The header always moves — stage, then
 * the current tool — so long stretches between the model's own messages
 * never read as a stall.
 */
function ActivityFeed({
  actions,
  stage,
  startedAt,
  cancelling,
}: {
  actions: AgentAction[];
  stage: PipelineStage | null;
  startedAt: number | null;
  cancelling: boolean;
}) {
  const recent = actions.slice(-6);
  const elapsed = useElapsed(startedAt);
  const running = recent.find((a) => a.status === "running");
  const headline = cancelling
    ? "stopping — finishing the current step"
    : (running?.label ?? (stage ? STAGE_LABELS[stage] : "starting…"));

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
