import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bot, Check, History, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import type { CliHistoryEntry } from "@atelier/protocol";
import { ListSearch, ListSearchEmpty } from "@/components/ui/list-search";
import { cn } from "@/lib/cn";
import { loadFirstCliHistory, loadMoreCliHistory, useCliConsoleStore } from "@/services/cli-console";
import { CliProviderLogo } from "@/views/cli/CliProviderLogo";
import type { SessionVm } from "@/state/sessions.store";

/**
 * A session matches when every whitespace-separated term appears in its
 * title, its last-message preview or its status. Terms are ANDed, so a
 * second word narrows the list rather than widening it.
 */
function matches(session: SessionVm, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const last = session.items[session.items.length - 1];
  const hay = [
    session.conversation.title,
    last?.text ?? "",
    session.previewText ?? "",
    session.status,
  ]
    .join(" ")
    .toLowerCase();
  return terms.every((term) => hay.includes(term));
}

export interface SessionListPanelProps {
  sessions: SessionVm[];
  selectedId: string | null;
  showCliHistory: boolean;
  selectedCliHistoryId: string | null;
  onShowCliHistory: (show: boolean) => void | Promise<void>;
  onSelect: (conversationId: string) => void;
  onCreate: () => void;
  onRename: (conversationId: string, title: string) => void;
  onDelete: (conversationId: string) => void;
  onResumeCliHistory: (entry: CliHistoryEntry) => Promise<void>;
}

/** Agent-session switcher: one row per parallel agent run. */
export function SessionListPanel(props: SessionListPanelProps) {
  const [query, setQuery] = useState("");
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyClosing, setHistoryClosing] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const history = useCliConsoleStore((s) => s.history);
  const historyHasMore = useCliConsoleStore((s) => s.historyHasMore);
  const cliChats = useCliConsoleStore((s) => s.chats);
  const showCliHistory = props.showCliHistory;
  const total = props.sessions.length;
  const shown = useMemo(
    () => props.sessions.filter((session) => matches(session, query)),
    [props.sessions, query]
  );
  const filtering = query.trim().length > 0;
  const shownHistory = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return history.filter((entry) =>
      terms.every((term) =>
        `${entry.title} ${entry.providerId} ${entry.cwd}`.toLowerCase().includes(term)
      )
    );
  }, [history, query]);

  const toggleCliHistory = () => {
    if (showCliHistory) {
      setHistoryClosing(true);
      void Promise.resolve(props.onShowCliHistory(false))
        .catch((error) => setHistoryError(error instanceof Error ? error.message : String(error)))
        .finally(() => setHistoryClosing(false));
      setQuery("");
      return;
    }
    props.onShowCliHistory(true);
    setQuery("");
    setHistoryError(null);
    setHistoryBusy(true);
    void loadFirstCliHistory()
      .catch((error) => setHistoryError(error instanceof Error ? error.message : String(error)))
      .finally(() => setHistoryBusy(false));
  };

  const loadMoreHistory = () => {
    setHistoryError(null);
    setHistoryBusy(true);
    void loadMoreCliHistory()
      .catch((error) => setHistoryError(error instanceof Error ? error.message : String(error)))
      .finally(() => setHistoryBusy(false));
  };

  const openHistory = async (entry: CliHistoryEntry) => {
    setOpeningId(`${entry.providerId}:${entry.id}`);
    setHistoryError(null);
    try {
      await props.onResumeCliHistory(entry);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpeningId(null);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="island-header justify-between">
        <span className="icon-tile icon-tile-sm">
          <Bot className="h-3.5 w-3.5" />
        </span>
        <span className="island-title">{showCliHistory ? "CLI history" : "Agents"}</span>
        <button
          type="button"
          title={showCliHistory ? "Back to agents" : "Claude and Codex session history"}
          aria-label={showCliHistory ? "Back to agents" : "Claude and Codex session history"}
          aria-pressed={showCliHistory}
          disabled={openingId !== null || historyClosing}
          onClick={toggleCliHistory}
          className="tool-btn ml-auto"
        >
          {showCliHistory ? <X className="h-4 w-4" /> : <History className="h-4 w-4" />}
        </button>
        <button
          type="button"
          title="Open Claude or Codex CLI"
          aria-label="Open Claude or Codex CLI"
          onClick={props.onCreate}
          className="tool-btn"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      {(showCliHistory ? history.length > 0 : total > 0) && (
        <div className="px-2 pb-2">
          <ListSearch
            value={query}
            onChange={setQuery}
            total={showCliHistory ? history.length : total}
            shown={showCliHistory ? shownHistory.length : shown.length}
            placeholder={showCliHistory ? "Search CLI history…" : `Search ${total} session${total === 1 ? "" : "s"}…`}
          />
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {showCliHistory ? (
          <>
            {historyBusy && history.length === 0 && (
              <p className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />Loading sessions…
              </p>
            )}
            {historyError && <p role="alert" className="px-2 py-2 text-xs text-destructive">{historyError}</p>}
            {!historyBusy && shownHistory.length === 0 && !historyHasMore && !historyError && (
              <p className="px-2 py-3 text-xs text-muted-foreground">No saved CLI sessions for this workspace.</p>
            )}
            {shownHistory.map((entry) => (
              <button
                key={`${entry.providerId}:${entry.id}`}
                type="button"
                disabled={openingId !== null || historyClosing}
                onClick={() => void openHistory(entry)}
                aria-current={props.selectedCliHistoryId === `${entry.providerId}:${entry.id}`}
                className={cn(
                  "flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left hover:bg-accent/60 disabled:opacity-60",
                  props.selectedCliHistoryId === `${entry.providerId}:${entry.id}` && "bg-primary/12 ring-1 ring-primary/30"
                )}
                title={`${entry.providerId === "claude" ? "Claude" : "Codex"}: ${entry.title || entry.id}`}
              >
                <span className="icon-tile icon-tile-sm shrink-0">
                  <CliProviderLogo providerId={entry.providerId} className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{entry.title || "Untitled session"}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {entry.providerId === "claude" ? "Claude" : "Codex"} · {new Date(entry.updatedAt).toLocaleString()}
                  </span>
                </span>
                {openingId === `${entry.providerId}:${entry.id}` && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              </button>
            ))}
            {historyHasMore && (
              <button
                type="button"
                disabled={historyBusy || historyClosing || openingId !== null}
                onClick={loadMoreHistory}
                className="flex w-full items-center justify-center gap-2 rounded-xl px-2 py-2 text-xs text-muted-foreground hover:bg-accent/60 disabled:opacity-60"
              >
                {historyBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {historyBusy ? "Loading more…" : "Load more sessions"}
              </button>
            )}
          </>
        ) : (
          <>
        {filtering && shown.length === 0 && (
          <ListSearchEmpty
            query={query}
            label="session"
            onClear={() => setQuery("")}
          />
        )}
        <AnimatePresence initial={false}>
          {shown.map((session) => (
            <SessionRow
              key={session.conversation.id}
              session={session}
              providerId={cliChats[session.conversation.id]?.providerId ?? null}
              active={session.conversation.id === props.selectedId}
              onClick={() => props.onSelect(session.conversation.id)}
              onRename={props.onRename}
              onDelete={props.onDelete}
            />
          ))}
        </AnimatePresence>
          </>
        )}
      </div>
    </div>
  );
}

export function StatusDot({
  status,
  className,
}: {
  status: SessionVm["status"];
  className?: string;
}) {
  return (
    <span className={cn("relative flex h-2 w-2 shrink-0", className)}>
      {status === "working" && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
      )}
      <span
        className={cn(
          "relative inline-flex h-2 w-2 rounded-full",
          status === "working" && "bg-primary",
          status === "idle" && "bg-muted-foreground/35",
          status === "error" && "bg-destructive"
        )}
      />
    </span>
  );
}

function SessionRow(props: {
  session: SessionVm;
  providerId: string | null;
  active: boolean;
  onClick: () => void;
  onRename: (conversationId: string, title: string) => void;
  onDelete: (conversationId: string) => void;
}) {
  const { session } = props;
  const providerLabel = props.providerId === "claude"
    ? "Claude CLI"
    : props.providerId === "codex" ? "Codex CLI" : null;
  const id = session.conversation.id;
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const last = session.items[session.items.length - 1];
  const preview =
    last?.text.replaceAll("\n", " ").trim() || session.previewText;
  const subtitle =
    session.status === "working"
      ? "Working…"
      : session.status === "error"
        ? (session.lastError ?? "Error")
        : (providerLabel ?? preview ?? "No messages yet");

  // A row that scrolls out of view mid-confirm must not keep a live "delete"
  // armed for whenever it comes back.
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0 }}
      className={cn(
        // An inset rounded row, not a full-bleed line: each session is a
        // separate running agent, so it reads better as an object in a list
        // than as a line in a tree.
        "group relative flex w-full items-center gap-2.5 rounded-xl py-2 pl-2 pr-2",
        "transition-colors",
        props.active
          ? "bg-primary/12 shadow-sm ring-1 ring-primary/30"
          : "hover:bg-accent/60"
      )}
    >
      {/* The tile carries the identity, the dot on its corner carries the
          state — one object, two facts, instead of a bare dot in a column. */}
      <span className="relative shrink-0">
        <motion.span
          className={cn(
            "icon-tile icon-tile-sm",
            props.active && "bg-primary/15 text-primary ring-1 ring-primary/25"
          )}
          animate={
            props.active
              ? { rotate: [0, -5, 5, 0], scale: [1, 1.08, 1] }
              : { rotate: 0, scale: 1 }
          }
          transition={
            props.active
              ? { duration: 1.8, repeat: Infinity, ease: "easeInOut" }
              : { duration: 0.16 }
          }
        >
          {props.providerId ? (
            <CliProviderLogo providerId={props.providerId} className="h-4 w-4" />
          ) : (
            <Bot className="h-3.5 w-3.5" />
          )}
        </motion.span>
        <StatusDot
          status={session.status}
          className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-card"
        />
      </span>

      {renaming ? (
        <RenameField
          initial={session.conversation.title}
          onCommit={(title) => {
            props.onRename(id, title);
            setRenaming(false);
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : (
        <button
          type="button"
          onClick={props.onClick}
          onDoubleClick={() => setRenaming(true)}
          title={session.conversation.title}
          aria-current={props.active}
          className="min-w-0 flex-1 pr-1 text-left group-hover:pr-14 group-focus-within:pr-14"
        >
          <span
            className={cn(
              "block truncate text-[13px] leading-snug",
              props.active ? "font-semibold" : "font-medium"
            )}
          >
            {session.conversation.title}
          </span>
          <span
            className={cn(
              "block truncate text-[11px]",
              session.status === "error"
                ? "text-destructive"
                : "text-muted-foreground"
            )}
          >
            {subtitle}
          </span>
        </button>
      )}

      {/*
        Row actions stay hidden until the row is hovered or focused, so the
        list still reads as a list — but they remain reachable by keyboard,
        which `hidden until hover` alone would not be.
      */}
      {!renaming && (
        <span
          className={cn(
            "absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5",
            "rounded-lg opacity-0 transition-opacity",
            props.active ? "bg-primary/10" : "bg-accent",
            "group-hover:opacity-100 group-focus-within:opacity-100",
            confirmDelete && "opacity-100"
          )}
        >
          {confirmDelete ? (
            <>
              <button
                type="button"
                title="Confirm delete"
                aria-label={`Confirm deleting ${session.conversation.title}`}
                onClick={() => props.onDelete(id)}
                className="tool-btn text-destructive"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                title="Cancel"
                aria-label="Cancel delete"
                onClick={() => setConfirmDelete(false)}
                className="tool-btn"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                title="Rename"
                aria-label={`Rename ${session.conversation.title}`}
                onClick={() => setRenaming(true)}
                className="tool-btn"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                title="Delete chat"
                aria-label={`Delete ${session.conversation.title}`}
                onClick={() => setConfirmDelete(true)}
                className="tool-btn"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </span>
      )}
    </motion.div>
  );
}

/** Inline title editor: Enter commits, Escape and blur abandon. */
export function RenameField(props: {
  initial: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(props.initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={props.onCancel}
      onKeyDown={(e) => {
        if (e.key === "Enter") props.onCommit(value);
        else if (e.key === "Escape") props.onCancel();
        // The list lives under global shortcuts; while typing a title they
        // are not what the keystroke meant.
        e.stopPropagation();
      }}
      aria-label="Chat title"
      className={cn(
        "min-w-0 flex-1 rounded-lg border border-border bg-card",
        "px-2 py-1 text-xs outline-none focus:border-primary"
      )}
    />
  );
}
