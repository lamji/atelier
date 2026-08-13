import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { History, Loader2, Plus, TerminalSquare, X } from "lucide-react";
import type { CliHistoryEntry } from "@atelier/protocol";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import {
  CLI_PROVIDERS,
  cliSessionTitle,
  closeCliSession,
  refreshCliHistory,
  renameCliSession,
  resumableCliHistory,
  resumeCliSession,
  useCliConsoleStore,
  type CliProvider,
  type CliSessionVm,
} from "@/services/cli-console";

/**
 * CLI mode's session switcher, in the slot the agent list normally occupies.
 *
 * Chat sessions are deliberately not shown here: in this mode the main view
 * is the provider's own CLI, and a chat you cannot open from a list is just
 * a dead row. They are untouched underneath — leaving CLI mode brings the
 * agent list back exactly as it was.
 *
 * One group per provider, because a CLI session belongs to the CLI that
 * runs it. The header's single add action asks which provider should own
 * the new session before either provider-specific flow starts.
 *
 * A row reads as its topic — the first thing asked in that session — rather
 * than "Codex 1", which told you nothing about which of two sessions you
 * wanted. Double-click renames, for when the first prompt was not the point.
 *
 * Under the running sessions come the provider's own past ones, the same
 * rows its `resume` screen offers — a session is the CLI's, not Atelier's,
 * so a list that only had the ones started here was showing a subset of
 * what exists. Clicking one resumes it in a new pty.
 */
export function CliSessionListPanel(props: {
  onActivateSession: () => void;
}) {
  const sessions = useCliConsoleStore((s) => s.sessions);
  const selectedId = useCliConsoleStore((s) => s.selectedId);
  const titles = useCliConsoleStore((s) => s.titles);
  const history = useCliConsoleStore((s) => s.history);
  const resumed = useCliConsoleStore((s) => s.resumed);
  const processing = useCliConsoleStore((s) => s.processing);
  const bootstrapped = useCliConsoleStore((s) => s.bootstrapped);
  const select = useCliConsoleStore((s) => s.select);
  const openProviderPicker = useCliConsoleStore((s) => s.openProviderPicker);
  /** At most one row is an input at a time, as in the terminal tab strip. */
  const [renaming, setRenaming] = useState<string | null>(null);
  /** The row being resumed, if any — resuming spawns a pty and takes time. */
  const [resuming, setResuming] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [providerFilter, setProviderFilter] = useState<string>("all");

  // The CLIs write their transcripts as they run, and one can be started
  // from a plain terminal at any moment, so the history is re-read on a slow
  // beat as well as whenever a session is created or closed.
  useEffect(() => {
    let cancelled = false;
    void refreshCliHistory().finally(() => {
      if (!cancelled) setLoadingHistory(false);
    });
    const timer = setInterval(() => void refreshCliHistory(), 60_000);
    const onFocus = () => void refreshCliHistory();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const resume = async (entry: CliHistoryEntry) => {
    props.onActivateSession();
    setResuming(entry.id);
    try {
      await resumeCliSession(entry);
    } finally {
      setResuming(null);
    }
  };

  const selectSession = (termId: string) => {
    select(termId);
    props.onActivateSession();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="island-header justify-between">
        <div className="flex items-center gap-1.5">
          <TerminalSquare className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="island-title">CLI</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title="New CLI session"
          aria-label="New CLI session"
          onClick={openProviderPicker}
          className="tool-btn !h-6 !w-6"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <div
        className="flex gap-1 border-b border-border/60 px-2 py-1"
        aria-label="Filter CLI sessions by provider"
      >
        {[{ id: "all", label: "All" }, ...CLI_PROVIDERS].map((provider) => (
          <Button
            key={provider.id}
            type="button"
            variant={providerFilter === provider.id ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={providerFilter === provider.id}
            onClick={() => setProviderFilter(provider.id)}
            className="h-6 flex-1 px-2 text-[11px]"
          >
            {provider.label}
          </Button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {!bootstrapped || loadingHistory ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/50" />
            <p className="text-[11px] text-muted-foreground">
              Loading CLI sessions…
            </p>
          </div>
        ) : (
          CLI_PROVIDERS.filter(
            (provider) =>
              providerFilter === "all" || provider.id === providerFilter
          ).map((provider) => (
            <ProviderGroup
              key={provider.id}
              provider={provider}
              sessions={sessions.filter((s) => s.providerId === provider.id)}
              history={resumableCliHistory(
                history,
                resumed,
                provider.id,
                sessions
              )}
              selectedId={selectedId}
              processing={processing}
              onSelect={selectSession}
              title={(session) => cliSessionTitle(session, titles)}
              renaming={renaming}
              onRename={setRenaming}
              resuming={resuming}
              onResume={resume}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ProviderGroup(props: {
  provider: CliProvider;
  sessions: CliSessionVm[];
  history: CliHistoryEntry[];
  selectedId: string | null;
  processing: Record<string, boolean>;
  onSelect: (termId: string) => void;
  title: (session: CliSessionVm) => string;
  renaming: string | null;
  onRename: (termId: string | null) => void;
  resuming: string | null;
  onResume: (entry: CliHistoryEntry) => void;
}) {
  const { provider } = props;
  const empty = props.sessions.length === 0 && props.history.length === 0;
  return (
    <div className="pb-1">
      <div className="flex items-center gap-1.5 py-0.5 pl-2 pr-1">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {provider.label}
        </span>
      </div>
      {empty ? (
        <p className="px-2 py-1 text-[11px] text-muted-foreground/70">
          No sessions yet.
        </p>
      ) : (
        <AnimatePresence initial={false}>
          {props.sessions.map((session) => (
            <SessionRow
              key={session.termId}
              session={session}
              provider={provider}
              title={props.title(session)}
              active={session.termId === props.selectedId}
              processing={Boolean(props.processing[session.termId])}
              renaming={props.renaming === session.termId}
              onClick={() => props.onSelect(session.termId)}
              onStartRename={() => props.onRename(session.termId)}
              onEndRename={() => props.onRename(null)}
            />
          ))}
        </AnimatePresence>
      )}
      {props.history.length > 0 && (
        <>
          {/* Labelled, because these rows behave differently from the ones
              above: nothing is running behind them until you click. */}
          <div className="px-2 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/60">
            Recent
          </div>
          {props.history.map((entry) => (
            <HistoryRow
              key={entry.id}
              entry={entry}
              resuming={props.resuming === entry.id}
              disabled={props.resuming !== null}
              onClick={() => props.onResume(entry)}
            />
          ))}
        </>
      )}
    </div>
  );
}

/** How long ago, in the resume screen's own shorthand. */
function since(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * One of the provider's past sessions. Not running: clicking it starts the
 * CLI's own resume command in a new pty, after which it becomes a live row
 * above and drops out of this list.
 */
function HistoryRow(props: {
  entry: CliHistoryEntry;
  resuming: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const { entry } = props;
  const title = entry.title || "Untitled session";
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      title={`${title} — click to resume`}
      className={cn(
        "group flex w-full items-center gap-2 py-1 pl-2 pr-2 text-left",
        "transition-colors hover:bg-accent/50",
        props.disabled && !props.resuming && "opacity-60"
      )}
    >
      <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-muted-foreground">
          {title}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground/60">
          {props.resuming ? "Resuming…" : since(entry.updatedAt)}
        </span>
      </span>
    </button>
  );
}

function SessionRow(props: {
  session: CliSessionVm;
  provider: CliProvider;
  title: string;
  active: boolean;
  processing: boolean;
  renaming: boolean;
  onClick: () => void;
  onStartRename: () => void;
  onEndRename: () => void;
}) {
  const { session, title } = props;
  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0 }}
      className={cn(
        "group relative flex w-full items-center gap-2 py-1 pl-2 pr-1",
        "transition-colors",
        props.active ? "bg-accent" : "hover:bg-accent/50"
      )}
    >
      {/* Slim active rule, matching the agent list and the editor tabs. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-[2px] bg-primary transition-opacity",
          props.active ? "opacity-100" : "opacity-0"
        )}
      />
      {props.processing ? (
        <Loader2
          className="h-3.5 w-3.5 shrink-0 animate-spin text-primary"
          aria-label="Session processing"
        />
      ) : (
        <TerminalSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      {props.renaming ? (
        <SessionNameInput
          initial={title}
          onCommit={(next) => {
            renameCliSession(session.termId, next);
            props.onEndRename();
          }}
          onCancel={props.onEndRename}
        />
      ) : (
        <button
          type="button"
          onClick={props.onClick}
          onDoubleClick={props.onStartRename}
          title={`${title} — double-click to rename`}
          aria-current={props.active}
          className="min-w-0 flex-1 text-left"
        >
          <span
            className={cn(
              "block truncate text-xs",
              props.active ? "font-semibold" : "font-medium"
            )}
          >
            {title}
          </span>
          {/* Once a topic takes the top line the ordinal moves down here:
              two sessions can be about the same thing, so which one is
              which still has to be readable. */}
          <span className="block truncate text-[11px] text-muted-foreground">
            {title === session.fallbackTitle
              ? props.provider.command
              : session.fallbackTitle}
          </span>
        </button>
      )}
      {/* Hidden until hover or focus, so the list still reads as a list —
          but reachable by keyboard, which `hidden until hover` is not. */}
      <button
        type="button"
        title="Close session"
        aria-label={`Close ${title}`}
        onClick={() => void closeCliSession(session.termId)}
        className={cn(
          "tool-btn shrink-0 opacity-0 transition-opacity",
          "group-hover:opacity-100 group-focus-within:opacity-100"
        )}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </motion.div>
  );
}

/**
 * The inline editor a row becomes while being renamed. Blur commits and
 * Escape discards, the same contract as the terminal tab strip — clicking
 * away keeps your typing rather than quietly throwing it out.
 */
function SessionNameInput(props: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(props.initial);
  const done = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus and select once, on mount. A ref callback would re-run on every
  // render and re-select after each keystroke.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    props.onCommit(value);
  };

  return (
    <input
      ref={inputRef}
      value={value}
      spellCheck={false}
      aria-label="CLI session name"
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") commit();
        if (event.key === "Escape") {
          done.current = true;
          props.onCancel();
        }
      }}
      className={cn(
        "min-w-0 flex-1 rounded border border-primary/60 bg-background",
        "px-1 py-0.5 text-xs outline-none"
      )}
    />
  );
}
