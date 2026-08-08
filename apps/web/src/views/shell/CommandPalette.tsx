import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CornerDownLeft, FileText, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { rankMentionEntries } from "@/lib/mention-tree";
import { bridge } from "@/services/bridge-client";
import type { Command } from "@/hooks/useCommandRegistry";

/** ">" is the VS Code convention for "this is a command, not a file". */
const COMMAND_PREFIX = ">";
const MAX_FILE_RESULTS = 40;
const MAX_COMMAND_RESULTS = 60;

export interface CommandPaletteProps {
  open: boolean;
  /** Initial query — ">" for command mode, "" for file mode. */
  initialQuery: string;
  commands: Command[];
  onOpenFile: (path: string) => void;
  onClose: () => void;
}

type Row =
  | { kind: "command"; command: Command }
  | { kind: "file"; path: string };

/**
 * The command center's palette: one input over two sources. A leading ">"
 * searches commands, anything else searches workspace files — the same split
 * VS Code uses, so the muscle memory transfers.
 *
 * Every command in here delegates to the handler its button already calls, and
 * file results open through the explorer's own openFile. The palette adds a way
 * to reach existing behaviour; it does not own any behaviour itself.
 */
export function CommandPalette(props: CommandPaletteProps) {
  const { open, onClose } = props;
  const [query, setQuery] = useState(props.initialQuery);
  const [active, setActive] = useState(0);
  const [files, setFiles] = useState<string[] | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const reduceMotion = useReducedMotion();
  // Focus is returned to whatever opened the palette, per dialog semantics.
  const restoreFocus = useRef<HTMLElement | null>(null);

  const isCommandMode = query.startsWith(COMMAND_PREFIX);
  const term = (isCommandMode ? query.slice(1) : query).trim();

  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    setQuery(props.initialQuery);
    setActive(0);
    // Autofocus via ref, after paint: the input does not exist until the
    // portal mounts.
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open, props.initialQuery]);

  useEffect(() => {
    if (open) return;
    const previous = restoreFocus.current;
    restoreFocus.current = null;
    previous?.focus?.();
  }, [open]);

  /*
   * The flat path list is fetched once per opening, not per keystroke: it is
   * one RPC over the whole tree, and filtering it locally is what keeps typing
   * responsive. Cleared on close so a reopened palette sees a fresh workspace.
   */
  useEffect(() => {
    if (!open) {
      setFiles(null);
      return;
    }
    let cancelled = false;
    void bridge
      .rpc("fs.files", {})
      .then(({ files: paths }) => {
        if (!cancelled) setFiles(paths);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const rows = useMemo((): Row[] => {
    if (isCommandMode) {
      const matched = filterCommands(props.commands, term);
      return matched
        .slice(0, MAX_COMMAND_RESULTS)
        .map((command) => ({ kind: "command", command }) as Row);
    }
    if (files === null) return [];
    const entries = files.map((path) => ({
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      isDir: false,
    }));
    const ranked = term
      ? rankMentionEntries(entries, term)
      : entries.slice(0, MAX_FILE_RESULTS);
    return ranked
      .slice(0, MAX_FILE_RESULTS)
      .map((entry) => ({ kind: "file", path: entry.path }) as Row);
  }, [files, isCommandMode, props.commands, term]);

  // A shrinking result set must never leave the cursor past the end.
  useEffect(() => {
    setActive((current) => (current >= rows.length ? 0 : current));
  }, [rows.length]);

  const commit = useCallback(
    (row: Row | undefined) => {
      if (!row) return;
      onClose();
      // After the palette is gone: a command may move focus or open a modal,
      // and it should not be fighting a closing dialog for it.
      if (row.kind === "command") row.command.run();
      else props.onOpenFile(row.path);
    },
    [onClose, props]
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      commit(rows[active]);
      return;
    }
    const step =
      event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowUp"
          ? -1
          : event.key === "PageDown"
            ? 8
            : event.key === "PageUp"
              ? -8
              : 0;
    if (step === 0) return;
    event.preventDefault();
    if (rows.length === 0) return;
    setActive((current) => {
      const next = current + step;
      // Wrap on single steps; clamp on paging.
      if (Math.abs(step) === 1) return (next + rows.length) % rows.length;
      return Math.min(rows.length - 1, Math.max(0, next));
    });
  };

  // Keep the cursor in view while arrowing through a long list.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${active}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [active, rows.length]);

  if (!open) return null;

  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={reduceMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.12 }}
        className="fixed inset-0 z-[200] flex items-start justify-center bg-black/40 pt-[10vh]"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          initial={reduceMotion ? false : { opacity: 0, y: -8, scale: 0.99 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
          transition={{ duration: 0.14, ease: [0.2, 0, 0.2, 1] }}
          onKeyDown={onKeyDown}
          className={cn(
            "flex w-[min(44rem,calc(100vw-3rem))] flex-col overflow-hidden",
            "rounded-lg border border-border bg-elevated shadow-2xl"
          )}
        >
          <div className="flex items-center gap-2 border-b border-border-subtle px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              spellCheck={false}
              autoComplete="off"
              aria-label="Search files, or type > for commands"
              placeholder="Search files by name, or type > for commands"
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              className={cn(
                "h-11 min-w-0 flex-1 bg-transparent text-[13px] outline-none",
                "placeholder:text-muted-foreground/60"
              )}
            />
            <kbd
              className={cn(
                "shrink-0 rounded border border-border px-1.5 py-0.5",
                "text-[10px] font-medium text-muted-foreground"
              )}
            >
              Esc
            </kbd>
          </div>

          <div
            ref={listRef}
            role="listbox"
            aria-label={isCommandMode ? "Commands" : "Files"}
            className="max-h-[min(52vh,26rem)] overflow-y-auto py-1"
          >
            {rows.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {!isCommandMode && files === null
                  ? "Loading workspace files…"
                  : isCommandMode
                    ? "No matching command."
                    : "No matching file."}
              </p>
            ) : (
              rows.map((row, index) => (
                <Option
                  key={row.kind === "command" ? row.command.id : row.path}
                  row={row}
                  index={index}
                  active={index === active}
                  showGroupHeader={
                    row.kind === "command" &&
                    groupOf(rows[index - 1]) !== row.command.group
                  }
                  onHover={() => setActive(index)}
                  onSelect={() => commit(row)}
                />
              ))
            )}
          </div>

          <div
            className={cn(
              "flex shrink-0 items-center gap-3 border-t border-border-subtle",
              "px-3 py-1.5 text-[10px] text-muted-foreground"
            )}
          >
            <span className="flex items-center gap-1">
              <CornerDownLeft className="h-3 w-3" /> run
            </span>
            <span>↑↓ navigate</span>
            <span className="ml-auto">
              {isCommandMode
                ? `${rows.length} command${rows.length === 1 ? "" : "s"}`
                : `${rows.length} file${rows.length === 1 ? "" : "s"}`}
            </span>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
}

function groupOf(row: Row | undefined): string | null {
  return row?.kind === "command" ? row.command.group : null;
}

function Option(props: {
  row: Row;
  index: number;
  active: boolean;
  showGroupHeader: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  const { row, active } = props;
  const Icon = row.kind === "command" ? row.command.icon : FileText;
  const title = row.kind === "command" ? row.command.title : basename(row.path);
  const detail = row.kind === "command" ? row.command.detail : dirname(row.path);

  return (
    <>
      {props.showGroupHeader && row.kind === "command" && (
        <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
          {row.command.group}
        </p>
      )}
      <div
        role="option"
        aria-selected={active}
        data-index={props.index}
        onMouseMove={props.onHover}
        onMouseDown={(event) => {
          // mousedown, not click: the input must not lose focus first.
          event.preventDefault();
          props.onSelect();
        }}
        className={cn(
          "flex cursor-pointer items-center gap-2.5 px-3 py-1.5",
          active && "bg-accent"
        )}
      >
        {Icon && (
          <Icon
            className={cn(
              "h-4 w-4 shrink-0",
              active ? "text-primary" : "text-muted-foreground"
            )}
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs">{title}</span>
          {detail && (
            <span className="block truncate text-[10px] text-muted-foreground/70">
              {detail}
            </span>
          )}
        </span>
        {row.kind === "command" && row.command.hint && (
          <kbd
            className={cn(
              "shrink-0 rounded border border-border px-1.5 py-0.5",
              "text-[10px] font-medium text-muted-foreground"
            )}
          >
            {row.command.hint}
          </kbd>
        )}
      </div>
    </>
  );
}

/** Prefix matches first, then substring, so short exact titles win. */
function filterCommands(commands: Command[], term: string): Command[] {
  if (!term) return commands;
  const q = term.toLowerCase();
  const scored: Array<{ command: Command; score: number }> = [];
  for (const command of commands) {
    const title = command.title.toLowerCase();
    const at = title.indexOf(q);
    if (at === 0) scored.push({ command, score: 0 });
    else if (at > 0) scored.push({ command, score: 1 });
    else if (command.group.toLowerCase().includes(q)) {
      scored.push({ command, score: 2 });
    }
  }
  scored.sort(
    (a, b) => a.score - b.score || a.command.title.localeCompare(b.command.title)
  );
  return scored.map((entry) => entry.command);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

function dirname(path: string): string | undefined {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? undefined : path.slice(0, slash);
}
