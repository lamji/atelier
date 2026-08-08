import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Cpu,
  FileCode2,
  FileText,
  Folder,
  Gauge,
  ImagePlus,
  ListPlus,
  Loader2,
  Paperclip,
  Plus,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type { MarkdownFile, ModelOption, SlashCommand } from "@atelier/protocol";
import { cn } from "@/lib/cn";
import {
  parentDir,
  rankMentionEntries,
  searchMentionFiles,
  splitMentionPath,
  type MentionEntry,
} from "@/lib/mention-tree";
import { Tooltip } from "@/components/ui/tooltip";
import { NoProviderModal } from "./NoProviderModal";
import { useMarkdownStore } from "@/state/markdown.store";
import { createMarkdownFile } from "@/hooks/useMarkdownViewModel";
import { useWorkspaceStore } from "@/state/workspace.store";
import {
  NO_PROMPT_FILE,
  useComposerViewModel,
  type EffortChoice,
  type ModelChoice,
} from "@/hooks/useComposerViewModel";

/** Composer grows with the text up to this height, then scrolls. */
const MAX_COMPOSER_HEIGHT = 160;

/** Used only when the SDK model probe fails (offline / older agent). */
const FALLBACK_MODELS: PickerOption[] = [
  ["default", "Default"],
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"],
];

/** [value, label] with an optional third slot for the menu's hint line. */
type PickerOption =
  | [string, string]
  | [string, string, string]
  | { separator: true; value: string; label: string };

/**
 * Model picker options from the live SDK roster, else the fallback. The
 * label carries the version the way /model names it ("Fable 5", "Sonnet 5",
 * "Opus 4.8"), so the row reads the actual version instead of a bare family
 * name — no marketing hint underneath.
 */
function modelOptions(models: ModelOption[]): PickerOption[] {
  if (models.length === 0) return FALLBACK_MODELS;
  const options: PickerOption[] = [];
  const order: Array<NonNullable<ModelOption["provider"]>> = [
    "claude",
    "ollama",
    "codex",
  ];
  for (const provider of order) {
    const rows = models.filter((m) => (m.provider ?? "claude") === provider);
    if (rows.length === 0) continue;
    options.push({
      separator: true,
      value: `provider:${provider}`,
      label: providerLabel(provider),
    });
    options.push(...rows.map((m) => [m.value, modelLabel(m)] as PickerOption));
  }
  return options;
}

function providerLabel(provider: NonNullable<ModelOption["provider"]>): string {
  switch (provider) {
    case "ollama":
      return "Ollama Cloud";
    case "ollama-local":
      return "Ollama (local)";
    case "codex":
      return "Codex";
    default:
      return "Claude";
  }
}

/**
 * Family + version pulled from the SDK blurb ("Opus 4.8 with 1M context ·
 * …" → "Opus 4.8"). The "default" row keeps its own label; anything without
 * a parseable version falls back to the bare family name.
 */
function modelLabel(m: ModelOption): string {
  if (m.provider === "codex") return m.label;
  if (m.value === "default") return m.label;
  const head = ((m.description ?? "").split("·")[0] ?? "").trim();
  const version = head.replace(/\s+with\b.*$/i, "").trim();
  return version || m.label;
}

function effortOptions(model: ModelOption | undefined): PickerOption[] {
  const levels = model?.reasoningLevels;
  const available =
    levels && levels.length > 0
      ? levels
      : ["low", "medium", "high", "xhigh", "max"];
  return [
    ["default", "Reasoning: default"],
    ...available.map((level) => [level, effortLabel(level)] as PickerOption),
  ];
}

function effortLabel(level: string): string {
  switch (level) {
    case "xhigh":
      return "Extra High";
    case "ultra":
      return "Ultra";
    default:
      return level.charAt(0).toUpperCase() + level.slice(1);
  }
}

/**
 * The chat composer: the textarea, its "/" and "@" menus, the staged
 * attachments and images, and the model/effort/plan/vibe picks.
 *
 * Owns the draft itself (via {@link useComposerViewModel}) and takes NO
 * props, so a keystroke re-renders this subtree and nothing else — the
 * transcript, the process rail, and the rest of the console stay put.
 */
export const Composer = memo(function Composer() {
  const vm = useComposerViewModel();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [providerAlert, setProviderAlert] = useState(false);

  /**
   * Send, unless there is nothing to send to. With every provider off the
   * turn would start against an empty roster, so the composer says why
   * instead — and keeps the draft.
   */
  const send = () => {
    if (vm.noProvidersEnabled) {
      setProviderAlert(true);
      return;
    }
    vm.send();
  };

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
  }, [vm.input]);

  // "/" menu is live while the first token is being typed, like Claude Code.
  const slashQuery =
    vm.input.startsWith("/") && !/\s/.test(vm.input)
      ? vm.input.slice(1).toLowerCase()
      : null;
  const slashMatches =
    slashQuery !== null && !slashDismissed
      ? vm.slashCommands
          .filter((c) => c.name.toLowerCase().includes(slashQuery))
          .slice(0, 12)
      : [];
  const slashOpen = slashMatches.length > 0;

  // "@" mention: the token being typed at the caret (mid-sentence too).
  // The token doubles as the browser's location — "@src/views/" lists that
  // folder — so arrowing in and out is just a rewrite of the token.
  const mention = mentionDismissed ? null : activeMention(vm.input, caret);
  const { dir: mentionDir, filter: mentionFilter } = splitMentionPath(
    mention?.query ?? ""
  );
  const { dirs, ensureDir, filePaths } = vm.mentions;
  const mentionActive = mention !== null;
  const mentionEntries = mentionActive ? dirs[mentionDir] : undefined;
  const mentionLoading = mentionActive && mentionEntries === undefined;

  // Pull the folder the token points at; each new "@src/…/" segment is a
  // fresh readdir, cached by the browser hook.
  useEffect(() => {
    if (mentionActive) ensureDir(mentionDir);
  }, [mentionActive, mentionDir, ensureDir]);

  const mentionMatches = useMemo(
    () => matchMentions(mentionEntries, mentionFilter, mentionDir, filePaths),
    [mentionEntries, mentionFilter, mentionDir, filePaths]
  );
  const selectedModel = useMemo(
    () => vm.models.find((model) => model.value === vm.model),
    [vm.models, vm.model]
  );
  const reasoningOptions = useMemo(
    () => effortOptions(selectedModel),
    [selectedModel]
  );
  useEffect(() => {
    if (
      vm.effort !== "default" &&
      !reasoningOptions.some((option) => optionValue(option) === vm.effort)
    ) {
      vm.changeEffort("default");
    }
  }, [vm, reasoningOptions]);
  // Stays open while a folder loads, and on an empty folder, so stepping
  // into one never looks like the menu just vanished.
  const mentionOpen =
    mentionActive &&
    (mentionLoading || mentionMatches.length > 0 || mentionFilter === "");

  const changeInput = (value: string) => {
    vm.setInput(value);
    setSlashDismissed(false);
    setSlashIndex(0);
    setMentionDismissed(false);
    setMentionIndex(0);
    // Caret sits just after the inserted text on a change event.
    setCaret(value.length - (vm.input.length - caret));
  };

  const syncCaret = () => {
    const el = composerRef.current;
    if (el) setCaret(el.selectionStart ?? el.value.length);
  };

  const pickSlash = (command: SlashCommand) => {
    vm.setInput(`/${command.name} `);
    setSlashDismissed(true);
  };

  /**
   * Stage files pasted into the composer (screenshots land here). All files
   * go to addImages, which filters and reports anything it skips — a plain
   * text paste carries no files, so typing is untouched.
   */
  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      e.preventDefault();
      vm.addImages(files);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      e.preventDefault();
      vm.addImages(files);
    }
  };

  /**
   * Puts the caret back in the composer at an absolute offset. The state
   * moves now — the menu reads its folder from it, so waiting a frame would
   * list the old one — and the DOM catches up once the value has rendered.
   */
  const focusCaretAt = (pos: number) => {
    setCaret(pos);
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  /** Rewrites the active "@…" token, leaving the menu open on the new path. */
  const setMentionToken = (token: string) => {
    if (!mention) return;
    const before = vm.input.slice(0, mention.start);
    const after = vm.input.slice(mention.end);
    vm.setInput(`${before}@${token}${after}`);
    setMentionIndex(0);
    focusCaretAt(mention.start + 1 + token.length);
  };

  /** Descends into a folder: "@src/" now lists that folder's children. */
  const openMentionDir = (entry: MentionEntry) => {
    setMentionToken(`${entry.path}/`);
  };

  /** Back out one level; false at the workspace root so ← moves the caret. */
  const closeMentionDir = (): boolean => {
    if (!mention || mentionDir === "") return false;
    const up = parentDir(mentionDir);
    setMentionToken(up ? `${up}/` : "");
    return true;
  };

  /**
   * Tab/Enter on a folder steps into it; on a file it replaces the active
   * "@token" with the bare path (no contents) and closes the menu.
   */
  const pickMention = (entry: MentionEntry) => {
    if (!mention) return;
    if (entry.isDir) {
      openMentionDir(entry);
      return;
    }
    const before = vm.input.slice(0, mention.start);
    const after = vm.input.slice(mention.end);
    vm.setInput(`${before}${entry.path} ${after}`);
    setMentionDismissed(true);
    focusCaretAt(before.length + entry.path.length + 1);
  };

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionDismissed(true);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        // Nothing to move through while a folder loads or comes back empty.
        if (mentionMatches.length === 0) return;
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setMentionIndex(
          (i) => (i + delta + mentionMatches.length) % mentionMatches.length
        );
        return;
      }
      // ←/→ walk the tree, but only with nothing to the right of the token —
      // mid-sentence they stay ordinary caret movement.
      const nextChar = vm.input[caret];
      const endOfToken = nextChar === undefined || /\s/.test(nextChar);
      if (e.key === "ArrowRight" && endOfToken) {
        const chosen = mentionMatches[mentionIndex] ?? mentionMatches[0];
        if (chosen?.isDir) {
          e.preventDefault();
          openMentionDir(chosen);
          return;
        }
      }
      if (e.key === "ArrowLeft" && endOfToken) {
        if (closeMentionDir()) {
          e.preventDefault();
          return;
        }
      }
      if (e.key === "Tab" || e.key === "Enter") {
        const chosen = mentionMatches[mentionIndex] ?? mentionMatches[0];
        if (chosen) {
          e.preventDefault();
          pickMention(chosen);
          return;
        }
        // Loading or empty folder — step aside so Enter still sends.
        setMentionDismissed(true);
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
      send();
    }
  };

  return (
    <div className="px-4 pb-3">
      <NoProviderModal
        open={providerAlert}
        onClose={() => setProviderAlert(false)}
      />
      <div className="mx-auto w-full max-w-3xl">
        {vm.error && (
          <motion.p
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {vm.error}
          </motion.p>
        )}
        {vm.attachments.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {vm.attachments.map((path) => (
              <span
                key={path}
                className="flex items-center gap-1 rounded-lg bg-accent px-2 py-0.5 font-mono text-[11px] text-accent-foreground"
              >
                <Paperclip className="h-3 w-3" />
                {path}
                <X
                  className="h-3 w-3 cursor-pointer hover:text-destructive"
                  onClick={() => vm.removeAttachment(path)}
                />
              </span>
            ))}
          </div>
        )}
        {vm.images.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-2">
            {vm.images.map((img) => (
              <div key={img.id} className="group relative">
                <img
                  src={img.dataUrl}
                  alt="attachment"
                  className="h-16 w-16 rounded-lg border border-white/10 object-cover"
                />
                <Tooltip content="Remove image">
                  <button
                    onClick={() => vm.removeImage(img.id)}
                    className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-white opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </Tooltip>
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
              if (e.target.files) vm.addImages(e.target.files);
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
                dir={mentionDir}
                loading={mentionLoading}
                onHover={setMentionIndex}
                onPick={pickMention}
              />
            )}
          </AnimatePresence>
          <div
            className={cn(
              "rounded-2xl bg-muted/60 transition-colors",
              "focus-within:bg-muted",
              dragging && "ring-2 ring-primary/60"
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
                value={vm.input}
                placeholder={
                  vm.busy
                    ? "Agent is working — send to queue a follow-up"
                    : "Describe a task, paste or drop a screenshot…"
                }
                disabled={!vm.connected}
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
                  "disabled:opacity-60"
                )}
              />
              {/* While the agent works, BOTH actions are offered: queue this
                  draft behind the run, or stop the run. Sending no longer
                  costs the task in flight, so stopping stops being the only
                  way to say something. */}
              <Tooltip content={vm.busy ? "Queue follow-up (Enter)" : "Send (Enter)"}>
                <motion.button
                  whileTap={{ scale: 0.92 }}
                  disabled={
                    !vm.connected ||
                    (!vm.input.trim() &&
                      vm.images.length === 0 &&
                      vm.promptFile === NO_PROMPT_FILE)
                  }
                  onClick={send}
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                    "transition-opacity hover:opacity-90 disabled:opacity-30",
                    vm.busy
                      ? "bg-muted text-foreground"
                      : "bg-primary text-primary-foreground"
                  )}
                >
                  {vm.busy ? (
                    <ListPlus className="h-4 w-4" />
                  ) : (
                    <ArrowUp className="h-4 w-4" />
                  )}
                </motion.button>
              </Tooltip>
              {vm.busy && (
                <Tooltip
                  content={
                    vm.cancelling
                      ? "Stopping — finishing the current step"
                      : "Cancel task"
                  }
                >
                  <motion.button
                    whileTap={{ scale: 0.92 }}
                    onClick={vm.cancel}
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                      "text-white hover:opacity-90",
                      vm.cancelling ? "bg-destructive/60" : "bg-destructive"
                    )}
                  >
                    {vm.cancelling ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Square className="h-4 w-4 fill-current" />
                    )}
                  </motion.button>
                </Tooltip>
              )}
            </div>
            {vm.queuedCount > 0 && (
              <div className="flex items-center gap-2 px-3 pb-1 text-[11px] text-muted-foreground">
                <ListPlus className="h-3 w-3" />
                <span>
                  {vm.queuedCount} follow-up{vm.queuedCount > 1 ? "s" : ""} queued
                </span>
                <button
                  type="button"
                  onClick={vm.clearQueue}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Clear
                </button>
              </div>
            )}
            <div className="flex items-center gap-1 px-2.5 pb-2 pt-0.5">
              <Tooltip content="Attach an image (or paste / drop a screenshot)">
                <button
                  type="button"
                  disabled={!vm.connected}
                  onClick={() => fileInputRef.current?.click()}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-35"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
              <ComposerMenu
                icon={Cpu}
                tooltip="Model"
                value={vm.model}
                options={modelOptions(vm.models)}
                onChange={(v) => vm.changeModel(v as ModelChoice)}
                shortLabel={(label) => label.replace(/\s*\(recommended\)/i, "")}
                interceptOpen={() => {
                  if (!vm.noProvidersEnabled) return false;
                  setProviderAlert(true);
                  return true;
                }}
              />
              <ComposerMenu
                icon={Gauge}
                tooltip="Reasoning effort"
                value={vm.effort}
                options={reasoningOptions}
                onChange={(v) => vm.changeEffort(v as EffortChoice)}
                shortLabel={(label) => label.replace(/^Reasoning:\s*/i, "")}
              />
              <PromptFileMenu
                value={vm.promptFile}
                files={vm.promptFiles}
                onChange={vm.setPromptFile}
              />
              <span className="mx-1 h-3.5 w-px shrink-0 bg-border" />
              <ComposerToggle
                icon={ClipboardList}
                label="Plan"
                active={vm.planMode}
                onToggle={vm.setPlanMode}
                tooltip="Plan mode: the agent proposes a plan for approval before touching files"
              />
              <ComposerToggle
                icon={Brain}
                label="Knowledge"
                active={vm.systemKnowledge}
                onToggle={vm.setSystemKnowledge}
                tooltip={
                  vm.systemKnowledge
                    ? "System knowledge ON: retrieval, impact, plan, review and session memory"
                    : "System knowledge OFF: a plain Claude/Codex turn — no retrieval, impact or memory"
                }
              />
              <ComposerChecks
                icon={Sparkles}
                label="Modes"
                tooltip="How the agent works on this project"
                items={[
                  {
                    key: "vibe",
                    label: "Vibe code",
                    hint: "Owns the feature end to end — UX, edge cases, polish",
                    checked: vm.vibe,
                    onChange: vm.changeVibe,
                  },
                  {
                    key: "autoReview",
                    label: "Auto review",
                    hint: "An independent reviewer checks the changes and can send them back for a fix",
                    checked: vm.autoReview,
                    onChange: vm.changeAutoReview,
                  },
                ]}
              />
              <span className="ml-auto hidden whitespace-nowrap text-[10px] text-muted-foreground/50 min-[560px]:inline">
                Enter ↵ · Shift+Enter newline
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

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

/**
 * Browsing shows the whole folder (the menu scrolls) — a cap there would
 * hide files that exist. The search fallback ranks across a subtree, so a
 * short list is enough there.
 */
const MAX_MENTION_BROWSE = 500;
const MAX_MENTION_SEARCH = 25;

/**
 * Rows for the open folder: its children, narrowed by whatever follows the
 * last "/". When nothing in that folder matches, falls back to a search over
 * everything beneath it, so "@ChatPanel" finds a nested file directly.
 */
function matchMentions(
  entries: MentionEntry[] | undefined,
  filter: string,
  dir: string,
  filePaths: string[]
): MentionEntry[] {
  if (entries === undefined) return [];
  if (filter === "") return entries.slice(0, MAX_MENTION_BROWSE);
  const local = rankMentionEntries(entries, filter);
  if (local.length > 0) return local.slice(0, MAX_MENTION_BROWSE);
  return searchMentionFiles(filePaths, dir, filter, MAX_MENTION_SEARCH);
}

/**
 * Workspace browser for "@" mentions: lists the folder you're in (the root
 * on a bare "@"), → steps into a folder, ← backs out, Tab/Enter selects.
 * Picking a file inserts its path, not its contents.
 */
function MentionMenu(props: {
  matches: MentionEntry[];
  selectedIndex: number;
  /** Folder being listed; "" is the workspace root. */
  dir: string;
  /** The folder's listing is still on the wire. */
  loading: boolean;
  onHover: (index: number) => void;
  onPick: (entry: MentionEntry) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [props.selectedIndex]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.12 }}
      className={cn(
        "absolute bottom-full left-0 right-0 z-40 mb-2",
        "rounded-xl border border-white/10 bg-card shadow-xl"
      )}
    >
      <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5">
        <Folder className="h-3 w-3 shrink-0 text-primary/70" />
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
          {props.dir === "" ? "workspace root" : `${props.dir}/`}
        </span>
        <span className="shrink-0 text-[9px] text-muted-foreground/50">
          ↑↓ move · → open · ← up · ⇥ select
        </span>
      </div>
      <ul ref={listRef} className="max-h-64 overflow-y-auto p-1 pt-0">
        {props.matches.length === 0 && (
          <li className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-muted-foreground">
            {props.loading ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin text-primary/70" />
                Reading folder…
              </>
            ) : (
              "Empty folder"
            )}
          </li>
        )}
        {props.matches.map((entry, index) => (
          <li key={entry.path}>
            <button
              type="button"
              data-selected={index === props.selectedIndex}
              // preventDefault keeps focus in the textarea while clicking.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => props.onPick(entry)}
              onMouseEnter={() => props.onHover(index)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left",
                index === props.selectedIndex && "bg-accent/60"
              )}
            >
              {entry.isDir ? (
                <Folder className="h-3.5 w-3.5 shrink-0 text-primary/70" />
              ) : (
                <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
              )}
              <span className="min-w-0 shrink truncate font-mono text-xs">
                {entry.name}
                {entry.isDir && "/"}
              </span>
              <MentionRowHint entry={entry} dir={props.dir} />
            </button>
          </li>
        ))}
      </ul>
    </motion.div>
  );
}

/**
 * Right-hand hint on a row: "›" for a folder you can step into, and the
 * parent path for a file surfaced by the search fallback from elsewhere.
 */
function MentionRowHint({ entry, dir }: { entry: MentionEntry; dir: string }) {
  if (entry.isDir) {
    return (
      <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
    );
  }
  const own = parentDir(entry.path);
  if (own === dir) return null;
  return (
    <span className="ml-auto min-w-0 truncate text-right font-mono text-[10px] text-muted-foreground/60">
      {own}/
    </span>
  );
}

function optionValue(option: PickerOption): string {
  return Array.isArray(option) ? option[0] : option.value;
}

function optionLabel(option: PickerOption): string {
  return Array.isArray(option) ? option[1] : option.label;
}

function isSeparator(
  option: PickerOption,
): option is { separator: true; value: string; label: string } {
  return !Array.isArray(option) && option.separator;
}

/**
 * Ghost-pill toggle for the composer's mode switches (Plan / Knowledge /
 * Vibe). Lit with the primary tint while active — same state, same
 * handlers as the old checkboxes, just IDE-style chrome.
 */
function ComposerToggle(props: {
  icon: typeof Brain;
  label: string;
  active: boolean;
  tooltip: string;
  onToggle: (next: boolean) => void;
}) {
  const Icon = props.icon;
  return (
    <Tooltip content={props.tooltip}>
      <button
        type="button"
        aria-pressed={props.active}
        onClick={() => props.onToggle(!props.active)}
        className={cn(
          "flex h-6 select-none items-center gap-1 rounded-md px-1.5",
          "text-[11px] font-medium transition-colors",
          props.active
            ? "bg-primary/15 text-primary"
            : "text-muted-foreground hover:bg-accent hover:text-foreground"
        )}
      >
        <Icon className="h-3.5 w-3.5" />
        {props.label}
      </button>
    </Tooltip>
  );
}

interface CheckItem {
  key: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

/**
 * Drop-up of independent checkboxes (Vibe code / Auto review). Unlike
 * ComposerMenu these are not one-of-N, and the menu stays open after a tick
 * so both can be set in a single visit.
 */
function ComposerChecks(props: {
  icon: typeof Brain;
  label: string;
  tooltip: string;
  items: CheckItem[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismissOnOutside(open, rootRef, () => setOpen(false));

  const Icon = props.icon;
  const onCount = props.items.filter((item) => item.checked).length;

  return (
    <div ref={rootRef} className="relative">
      <Tooltip content={props.tooltip}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="true"
          aria-expanded={open}
          className={cn(
            "flex h-6 select-none items-center gap-1 rounded-md px-1.5",
            "text-[11px] font-medium transition-colors",
            onCount > 0
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
            open && onCount === 0 && "bg-accent text-foreground"
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {props.label}
          <ChevronDown
            className={cn(
              "h-3 w-3 shrink-0 opacity-60 transition-transform",
              open && "rotate-180"
            )}
          />
        </button>
      </Tooltip>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.12 }}
            className={cn(
              "absolute bottom-full left-0 z-50 mb-1 w-64 rounded-lg",
              "border border-border bg-card p-1 shadow-xl"
            )}
          >
            {props.items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitemcheckbox"
                aria-checked={item.checked}
                onClick={() => item.onChange(!item.checked)}
                className={cn(
                  "flex w-full items-start gap-2 rounded-md px-2 py-1.5",
                  "text-left transition-colors hover:bg-accent/60"
                )}
              >
                <span
                  className={cn(
                    "mt-px flex h-3.5 w-3.5 shrink-0 items-center justify-center",
                    "rounded border transition-colors",
                    item.checked
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border"
                  )}
                >
                  {item.checked && <Check className="h-2.5 w-2.5" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-[11px] text-foreground">
                    {item.label}
                  </span>
                  <span className="block text-[10px] leading-tight text-muted-foreground">
                    {item.hint}
                  </span>
                </span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Closes a drop-up on an outside click or Escape, while it is open. */
function useDismissOnOutside(
  open: boolean,
  ref: React.RefObject<HTMLElement | null>,
  close: () => void
): void {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
    // `close` is a fresh arrow each render; the deps that matter are open/ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ref]);
}

/**
 * Compact drop-up picker pill (model, reasoning effort). Replaces the
 * bordered Select in the composer row; separators become group headers.
 */
function ComposerMenu(props: {
  icon: typeof Brain;
  tooltip: string;
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  /** Compresses the selected label for the trigger pill. */
  shortLabel?: (label: string) => string;
  /**
   * Runs before the menu opens; returning true swallows the click. Lets a
   * caller answer the click with an explanation when the list would be
   * meaningless — e.g. no provider is enabled.
   */
  interceptOpen?: () => boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const Icon = props.icon;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const selected = props.options.find(
    (o) => !isSeparator(o) && optionValue(o) === props.value
  );
  const rawLabel = selected ? optionLabel(selected) : props.value;
  const label = props.shortLabel ? props.shortLabel(rawLabel) : rawLabel;

  return (
    <div ref={rootRef} className="relative">
      <Tooltip content={props.tooltip}>
        <button
          type="button"
          onClick={() => {
            if (props.interceptOpen?.()) return;
            setOpen((v) => !v);
          }}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn(
            "flex h-6 select-none items-center gap-1 rounded-md px-1.5",
            "text-[11px] text-muted-foreground transition-colors",
            "hover:bg-accent hover:text-foreground",
            open && "bg-accent text-foreground"
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          <span className="max-w-[9rem] truncate">{label}</span>
          <ChevronDown
            className={cn(
              "h-3 w-3 shrink-0 opacity-60 transition-transform",
              open && "rotate-180"
            )}
          />
        </button>
      </Tooltip>

      <AnimatePresence>
        {open && (
          <motion.ul
            role="listbox"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.12 }}
            className={cn(
              "absolute bottom-full left-0 z-50 mb-1 max-h-64 w-56",
              "overflow-y-auto rounded-lg border border-border bg-card p-1",
              "shadow-xl"
            )}
          >
            {props.options.map((option) =>
              isSeparator(option) ? (
                <li
                  key={option.value}
                  className="px-2 pb-0.5 pt-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60 first:pt-0.5"
                >
                  {option.label}
                </li>
              ) : (
                <li key={optionValue(option)} role="option"
                  aria-selected={optionValue(option) === props.value}
                >
                  <button
                    type="button"
                    onClick={() => {
                      props.onChange(optionValue(option));
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1",
                      "text-left text-[11px] transition-colors",
                      optionValue(option) === props.value
                        ? "bg-primary/10 text-primary"
                        : "text-foreground hover:bg-accent/60"
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {optionLabel(option)}
                    </span>
                    {Array.isArray(option) && option[2] && (
                      <span className="shrink-0 text-[10px] text-muted-foreground/60">
                        {option[2]}
                      </span>
                    )}
                    {optionValue(option) === props.value && (
                      <Check className="h-3 w-3 shrink-0" />
                    )}
                  </button>
                </li>
              )
            )}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Prompt-file picker: workspace .md files (the .atelier catalog) offered
 * as ready-made prompts. Always visible; the menu has a search box and a
 * permanent "Create prompt" footer that writes a new `.atelier/*.md` file
 * inline and selects it — creating a prompt is the reason the menu is open
 * often enough that it should not be hidden behind an empty catalog.
 */
function PromptFileMenu(props: {
  value: string;
  files: MarkdownFile[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = props.files.find((f) => f.path === props.value);

  // Click-outside / Escape close; the search and draft reset on every open.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setDraft(null);
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const matches = q
    ? props.files.filter(
        (f) =>
          f.title.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
      )
    : props.files;

  const pick = (value: string) => {
    props.onChange(value);
    setOpen(false);
  };

  // Seed the name box from whatever was typed in the search: a search that
  // found nothing is usually the name of the prompt you meant to write.
  const startCreate = () => setDraft(query.trim());

  const submitCreate = async () => {
    const name = (draft ?? "").trim();
    if (!name || saving) return;
    setSaving(true);
    try {
      const path = await createMarkdownFile(name);
      if (!path) return;
      // Created prompts are almost always meant for the message you are
      // about to send, so select it rather than just listing it.
      props.onChange(path);
      setDraft(null);
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  /** Full editing lives in the Markdown panel, not this dropdown. */
  const openMarkdownPanel = () => {
    setOpen(false);
    useMarkdownStore.getState().setCreating(true);
    useWorkspaceStore.getState().setActivityView("markdown");
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-6 select-none items-center gap-1 rounded-md px-1.5",
          "text-[11px] outline-none transition-colors",
          selected
            ? "bg-primary/15 text-primary"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
          open && !selected && "bg-accent text-foreground"
        )}
      >
        <FileText className="h-3.5 w-3.5" />
        <span className="max-w-[9rem] truncate">
          {selected?.title ?? "Prompt"}
        </span>
        <ChevronDown
          className={cn(
            "h-3 w-3 shrink-0 opacity-60 transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.12 }}
            className={cn(
              "absolute bottom-full left-0 z-50 mb-1 w-64 max-w-[80vw]",
              "overflow-hidden rounded-lg border border-border bg-card p-1 shadow-xl"
            )}
          >
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search markdown files…"
              className={cn(
                "mb-1 w-full rounded-md bg-muted/60 px-2 py-1 text-[11px]",
                "outline-none placeholder:text-muted-foreground/50"
              )}
            />
            {matches.length === 0 ? (
              <p className="px-2 py-1.5 text-[10px] text-muted-foreground/60">
                {props.files.length === 0
                  ? "No markdown files yet."
                  : "No matches."}
              </p>
            ) : (
              <ul className="max-h-56 overflow-y-auto">
                {props.value !== NO_PROMPT_FILE && (
                  <li>
                    <button
                      type="button"
                      onClick={() => pick(NO_PROMPT_FILE)}
                      className="w-full rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                    >
                      No prompt file
                    </button>
                  </li>
                )}
                {matches.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      onClick={() => pick(file.path)}
                      className={cn(
                        "flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-[11px]",
                        file.path === props.value
                          ? "text-primary"
                          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{file.title}</span>
                        <span className="mt-0.5 block truncate font-mono text-[10px] leading-snug opacity-60">
                          {file.path}
                        </span>
                      </span>
                      {file.path === props.value && (
                        <Check className="mt-0.5 h-3 w-3 shrink-0" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-1 border-t border-border pt-1">
              {draft === null ? (
                <button
                  type="button"
                  onClick={startCreate}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-md px-2 py-1",
                    "text-left text-[11px] text-primary",
                    "outline-none transition-colors hover:bg-accent/60"
                  )}
                >
                  <Plus className="h-3 w-3 shrink-0" />
                  Create prompt
                </button>
              ) : (
                <div className="flex items-center gap-1 px-1 pb-0.5">
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void submitCreate();
                      }
                      // Cancel the name box without closing the whole menu.
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setDraft(null);
                      }
                    }}
                    placeholder="prompt-name"
                    className={cn(
                      "min-w-0 flex-1 rounded-md bg-muted/60 px-2 py-1",
                      "font-mono text-[11px] outline-none",
                      "placeholder:text-muted-foreground/50"
                    )}
                  />
                  <button
                    type="button"
                    onClick={() => void submitCreate()}
                    disabled={saving || draft.trim() === ""}
                    className={cn(
                      "shrink-0 rounded-md px-2 py-1 text-[11px] font-medium",
                      "text-primary outline-none transition-colors",
                      "hover:bg-accent/60 disabled:opacity-40"
                    )}
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={openMarkdownPanel}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-md px-2 py-1",
                  "text-left text-[10px] text-muted-foreground/70",
                  "outline-none transition-colors hover:bg-accent/60"
                )}
              >
                <FileText className="h-3 w-3 shrink-0" />
                Manage in Markdown panel
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
