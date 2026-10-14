import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  BookOpen,
  Bot,
  Check,
  History,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type { CliHistoryEntry } from "@atelier/protocol";
import { ListSearch, ListSearchEmpty } from "@/components/ui/list-search";
import { cn } from "@/lib/cn";
import { loadFirstCliHistory, loadMoreCliHistory, useCliConsoleStore } from "@/services/cli-console";
import {
  docsForSession,
  refreshCliDocs,
  sessionKeys,
  useCliDocsStore,
} from "@/services/cli-docs";
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

function providerName(providerId: string | null): string {
  return providerId === "claude" ? "Claude" : "Codex";
}

/**
 * A documentation sidebar's nav row: one line of text, no icon, and a soft
 * rounded highlight on the page you are on.
 */
const NAV_ROW =
  "group relative flex w-full items-center rounded-lg px-3 py-1.5 " +
  "text-left text-[13px] leading-snug transition-colors";
const NAV_ROW_IDLE =
  "text-muted-foreground hover:bg-accent/50 hover:text-foreground";
const NAV_ROW_ACTIVE = "bg-accent font-medium text-foreground";

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
  /** False where the host already has its own history toggle. */
  historyToggle?: boolean;
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
  const cliProcessing = useCliConsoleStore((s) => s.processing);
  const cliResumed = useCliConsoleStore((s) => s.resumed);
  const cliDocs = useCliDocsStore((s) => s.docs);
  // The list is what shows the book icon, so it asks for the reports itself
  // rather than waiting on a CLI pane to have been opened first.
  useEffect(() => {
    void refreshCliDocs();
  }, []);
  /** How many `document` reports each session has written. */
  const docCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    if (cliDocs.length === 0) return counts;
    for (const session of props.sessions) {
      const id = session.conversation.id;
      const keys = sessionKeys(id, cliChats[id], cliResumed);
      counts[id] = docsForSession(cliDocs, keys).length;
    }
    return counts;
  }, [props.sessions, cliChats, cliResumed, cliDocs]);
  /*
   * In progress right now. An agent chat says so itself; a CLI row is an
   * empty conversation whose status never moves, so its pty is asked instead.
   */
  const isBusy = (session: SessionVm): boolean => {
    if (session.status === "working") return true;
    const termId = cliChats[session.conversation.id]?.termId;
    return Boolean(termId && cliProcessing[termId]);
  };
  const showCliHistory = props.showCliHistory;
  const total = props.sessions.length;
  /*
   * When a session was last worked in. A CLI row is an empty conversation
   * standing in for a pty, so its own updatedAt is only when it was opened;
   * the provider's transcript knows when it was last actually used.
   */
  const lastActive = useMemo(() => {
    const transcripts = new Map(history.map((entry) => [entry.id, entry]));
    const byId: Record<string, number> = {};
    for (const session of props.sessions) {
      const { id, updatedAt } = session.conversation;
      const sessionId = cliChats[id]?.sessionId;
      const transcript = sessionId ? transcripts.get(sessionId) : undefined;
      byId[id] = Math.max(updatedAt, transcript?.updatedAt ?? 0);
    }
    return byId;
  }, [props.sessions, cliChats, history]);
  // The session you are in leads; everything else is newest first.
  const ordered = useMemo(() => {
    const rank = (session: SessionVm) =>
      session.conversation.id === props.selectedId ? 0 : 1;
    const recency = (session: SessionVm) =>
      lastActive[session.conversation.id] ?? 0;
    return [...props.sessions].sort(
      (a, b) => rank(a) - rank(b) || recency(b) - recency(a)
    );
  }, [props.sessions, props.selectedId, lastActive]);
  const shown = useMemo(
    () => ordered.filter((session) => matches(session, query)),
    [ordered, query]
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
        {props.historyToggle !== false && (
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
        )}
        <button
          type="button"
          title="Open Claude or Codex CLI"
          aria-label="Open Claude or Codex CLI"
          onClick={props.onCreate}
          className={cn("tool-btn", props.historyToggle === false && "ml-auto")}
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
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
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
            {shownHistory.map((entry) => {
              const key = `${entry.providerId}:${entry.id}`;
              const current = props.selectedCliHistoryId === key;
              const title = entry.title || "Untitled session";
              const when = new Date(entry.updatedAt).toLocaleString();
              return (
                <button
                  key={key}
                  type="button"
                  disabled={openingId !== null || historyClosing}
                  onClick={() => void openHistory(entry)}
                  aria-current={current}
                  title={`${providerName(entry.providerId)} · ${when}\n${title}`}
                  className={cn(
                    NAV_ROW,
                    "gap-2 disabled:opacity-60",
                    current ? NAV_ROW_ACTIVE : NAV_ROW_IDLE
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{title}</span>
                  {openingId === key && (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  )}
                </button>
              );
            })}
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
        {/*
          No enter/exit fade here. The list re-sorts on every selection and
          refresh, and a row whose fade was interrupted by one stayed at
          opacity 0: present, taking its space, and invisible.
        */}
        {shown.map((session) => (
          <SessionRow
            key={session.conversation.id}
            session={session}
            active={session.conversation.id === props.selectedId}
            busy={isBusy(session)}
            docCount={docCounts[session.conversation.id] ?? 0}
            onOpenDocs={() => {
              props.onSelect(session.conversation.id);
              useCliDocsStore.getState().open(session.conversation.id);
            }}
            onClick={() => props.onSelect(session.conversation.id)}
            onRename={props.onRename}
            onDelete={props.onDelete}
          />
        ))}
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
  active: boolean;
  /** A run is in flight — shown as a spinner so progress is visible. */
  busy: boolean;
  /** Reports the `document` skill wrote from this session. */
  docCount: number;
  onOpenDocs: () => void;
  onClick: () => void;
  onRename: (conversationId: string, title: string) => void;
  onDelete: (conversationId: string) => void;
}) {
  const { session } = props;
  const id = session.conversation.id;
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const hint =
    session.status === "error"
      ? `${session.conversation.title}\n${session.lastError ?? "Error"}`
      : session.conversation.title;

  // A row that scrolls out of view mid-confirm must not keep a live "delete"
  // armed for whenever it comes back.
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  return (
    <motion.div
      // Position only: a re-sort slides rows, and nothing can strand one.
      layout="position"
      // A line in a documentation sidebar: the title and nothing else. State
      // only speaks up when there is some — a spinner while a run is in
      // progress, a dot on error.
      className={cn(NAV_ROW, props.active ? NAV_ROW_ACTIVE : NAV_ROW_IDLE)}
    >
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
          title={hint}
          aria-current={props.active}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 text-left",
            props.docCount > 0
              ? "group-hover:pr-20 group-focus-within:pr-20"
              : "group-hover:pr-14 group-focus-within:pr-14"
          )}
        >
          <span className="min-w-0 flex-1 truncate">
            {session.conversation.title}
          </span>
          {props.busy ? (
            <Loader2
              aria-label="In progress"
              className="h-3.5 w-3.5 shrink-0 animate-spin text-primary"
            />
          ) : (
            session.status === "error" && <StatusDot status="error" />
          )}
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
            "absolute right-1 top-1/2 flex -translate-y-1/2 items-center",
            "gap-0.5 opacity-0 transition-opacity",
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
              {props.docCount > 0 && (
                <button
                  type="button"
                  title={
                    props.docCount === 1
                      ? "Open documentation"
                      : `Open documentation (${props.docCount})`
                  }
                  aria-label={`Open documentation for ${session.conversation.title}`}
                  onClick={props.onOpenDocs}
                  className="tool-btn"
                >
                  <BookOpen className="h-3.5 w-3.5" />
                </button>
              )}
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
