import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bot, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { SessionVm } from "@/state/sessions.store";

export interface SessionListPanelProps {
  sessions: SessionVm[];
  selectedId: string | null;
  onSelect: (conversationId: string) => void;
  onCreate: () => void;
  onRename: (conversationId: string, title: string) => void;
  onDelete: (conversationId: string) => void;
}

/** Agent-session switcher: one row per parallel agent run. */
export function SessionListPanel(props: SessionListPanelProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="island-header justify-between">
        <div className="flex items-center gap-1.5">
          <Bot className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="island-title">Agents</span>
        </div>
        <button
          type="button"
          title="New agent session"
          aria-label="New agent session"
          onClick={props.onCreate}
          className="tool-btn ml-auto"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        <AnimatePresence initial={false}>
          {props.sessions.map((session) => (
            <SessionRow
              key={session.conversation.id}
              session={session}
              active={session.conversation.id === props.selectedId}
              onClick={() => props.onSelect(session.conversation.id)}
              onRename={props.onRename}
              onDelete={props.onDelete}
            />
          ))}
        </AnimatePresence>
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
  onClick: () => void;
  onRename: (conversationId: string, title: string) => void;
  onDelete: (conversationId: string) => void;
}) {
  const { session } = props;
  const id = session.conversation.id;
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const last = session.items[session.items.length - 1];
  const subtitle =
    session.status === "working"
      ? "Working…"
      : session.status === "error"
        ? (session.lastError ?? "Error")
        : (last?.text.replaceAll("\n", " ") ?? "No messages yet");

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
        // Full-bleed list row, not a card: a sidebar list reads as one column
        // when the rows share the panel's own edges.
        "group relative flex w-full items-center gap-2 py-1 pl-2 pr-1",
        "transition-colors",
        props.active ? "bg-accent" : "hover:bg-accent/50"
      )}
    >
      {/* Slim active rule, matching the activity rail and the editor tabs. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-[2px] bg-primary transition-opacity",
          props.active ? "opacity-100" : "opacity-0"
        )}
      />
      <StatusDot status={session.status} />

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
          className="min-w-0 flex-1 text-left"
        >
          <span
            className={cn(
              "block truncate text-xs",
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
            "flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity",
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
function RenameField(props: {
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
        "min-w-0 flex-1 rounded border border-border bg-background",
        "px-1.5 py-0.5 text-xs outline-none focus:border-primary"
      )}
    />
  );
}
