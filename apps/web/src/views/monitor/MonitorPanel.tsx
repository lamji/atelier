import { motion } from "framer-motion";
import { Gauge } from "lucide-react";
import { StatusDot } from "@/views/sessions/SessionListPanel";
import type { SessionVm } from "@/state/sessions.store";

export interface MonitorPanelProps {
  sessions: SessionVm[];
  workingCount: number;
  onSelect: (conversationId: string) => void;
}

/** Multi-agent monitor: every session and what it is doing right now. */
export function MonitorPanel(props: MonitorPanelProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="island-header">
        <span className="icon-tile icon-tile-sm">
          <Gauge className="h-3.5 w-3.5" />
        </span>
        <span className="island-title">Monitor</span>
        <span className="chip chip-accent ml-auto">
          {props.workingCount}/{props.sessions.length} active
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
        {props.sessions.map((session) => (
          <motion.button
            key={session.conversation.id}
            layout
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            onClick={() => props.onSelect(session.conversation.id)}
            className="w-full rounded-xl bg-muted/60 px-3 py-2.5 text-left transition-colors hover:bg-accent"
          >
            <div className="flex items-center gap-2">
              <StatusDot status={session.status} />
              <span className="truncate text-xs font-medium">
                {session.conversation.title}
              </span>
            </div>
            <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
              {session.status === "working"
                ? (session.thinking.slice(-160) || "Running task…")
                : session.status === "error"
                  ? (session.lastError ?? "Error")
                  : "Idle"}
            </p>
          </motion.button>
        ))}
      </div>
    </div>
  );
}
