import { AnimatePresence, motion } from "framer-motion";
import { Bot, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import type { SessionVm } from "@/state/sessions.store";

export interface SessionListPanelProps {
  sessions: SessionVm[];
  selectedId: string | null;
  onSelect: (conversationId: string) => void;
  onCreate: () => void;
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
        <motion.button
          whileTap={{ scale: 0.9 }}
          title="New agent session"
          onClick={props.onCreate}
          className={cn(
            "flex h-6 items-center gap-1 rounded-lg bg-primary/10 px-2",
            "text-xs font-medium text-primary hover:bg-primary/20"
          )}
        >
          <Plus className="h-3.5 w-3.5" />
          New
        </motion.button>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        <AnimatePresence initial={false}>
          {props.sessions.map((session) => (
            <SessionRow
              key={session.conversation.id}
              session={session}
              active={session.conversation.id === props.selectedId}
              onClick={() => props.onSelect(session.conversation.id)}
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
}) {
  const { session } = props;
  const last = session.items[session.items.length - 1];
  const subtitle =
    session.status === "working"
      ? "Working…"
      : session.status === "error"
        ? (session.lastError ?? "Error")
        : (last?.text.replaceAll("\n", " ") ?? "No messages yet");

  return (
    <motion.button
      layout
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0 }}
      onClick={props.onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left",
        "transition-colors",
        props.active ? "bg-accent" : "hover:bg-accent/40",
        session.status === "working" && "glow-working"
      )}
    >
      <StatusDot status={session.status} />
      <span className="min-w-0 flex-1">
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
      </span>
    </motion.button>
  );
}
