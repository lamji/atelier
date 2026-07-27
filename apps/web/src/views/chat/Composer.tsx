import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUp,
  ChevronRight,
  ClipboardList,
  FileCode2,
  Folder,
  ImagePlus,
  Loader2,
  Paperclip,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type { ModelOption, SlashCommand } from "@atelier/protocol";
import { cn } from "@/lib/cn";
import {
  parentDir,
  rankMentionEntries,
  searchMentionFiles,
  splitMentionPath,
  type MentionEntry,
} from "@/lib/mention-tree";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import {
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
type PickerOption = [string, string] | [string, string, string];

/**
 * Model picker options from the live SDK roster, else the fallback. The
 * label carries the version the way /model names it ("Fable 5", "Sonnet 5",
 * "Opus 4.8"), so the row reads the actual version instead of a bare family
 * name — no marketing hint underneath.
 */
function modelOptions(models: ModelOption[]): PickerOption[] {
  if (models.length === 0) return FALLBACK_MODELS;
  return models.map((m) => [m.value, modelLabel(m)]);
}

/**
 * Family + version pulled from the SDK blurb ("Opus 4.8 with 1M context ·
 * …" → "Opus 4.8"). The "default" row keeps its own label; anything without
 * a parseable version falls back to the bare family name.
 */
function modelLabel(m: ModelOption): string {
  if (m.value === "default") return m.label;
  const head = (m.description ?? "").split("·")[0].trim();
  const version = head.replace(/\s+with\b.*$/i, "").trim();
  return version || m.label;
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
      vm.send();
    }
  };

  return (
    <div className="px-4 pb-3">
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
                    ? "Agent is working — you can cancel or switch sessions"
                    : "Describe a task, paste or drop a screenshot…"
                }
                disabled={!vm.connected || vm.busy}
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
              {vm.busy ? (
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
                    disabled={vm.cancelling}
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
              ) : (
                <Tooltip content="Send (Enter)">
                  <motion.button
                    whileTap={{ scale: 0.92 }}
                    disabled={
                      !vm.connected ||
                      (!vm.input.trim() && vm.images.length === 0)
                    }
                    onClick={vm.send}
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                      "bg-primary text-primary-foreground transition-opacity",
                      "hover:opacity-90 disabled:opacity-30"
                    )}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </motion.button>
                </Tooltip>
              )}
            </div>
            <div className="flex items-center gap-2 px-3 pb-2 pt-0.5">
              <Tooltip content="Attach an image (or paste / drop a screenshot)">
                <button
                  type="button"
                  disabled={!vm.connected || vm.busy}
                  onClick={() => fileInputRef.current?.click()}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-35"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
              <ComposerSelect
                value={vm.model}
                onChange={(v) => vm.changeModel(v as ModelChoice)}
                options={modelOptions(vm.models)}
              />
              <ComposerSelect
                value={vm.effort}
                onChange={(v) => vm.changeEffort(v as EffortChoice)}
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
                  checked={vm.planMode}
                  onChange={(e) => vm.setPlanMode(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--primary)]"
                />
                <ClipboardList className="h-3.5 w-3.5" />
                Plan mode
              </label>
              <Tooltip content="Vibe coding: the agent owns the feature end to end — UX, edge cases, polish">
                <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground">
                  <input
                    type="checkbox"
                    checked={vm.vibe}
                    onChange={(e) => vm.changeVibe(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--primary)]"
                  />
                  <Sparkles className="h-3.5 w-3.5" />
                  Vibe
                </label>
              </Tooltip>
              <span className="ml-auto text-[10px] text-muted-foreground/50">
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

function ComposerSelect(props: {
  value: string;
  onChange: (value: string) => void;
  options: PickerOption[];
}) {
  return (
    <Select
      value={props.value}
      onChange={props.onChange}
      direction="up"
      options={props.options.map(([value, label, hint]) => ({
        value,
        label,
        hint,
      }))}
    />
  );
}
