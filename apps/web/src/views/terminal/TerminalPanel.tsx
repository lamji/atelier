import { useEffect, useRef } from "react";
import { Plus, TerminalSquare, X } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/cn";
import type { TerminalSession } from "@atelier/protocol";

export interface TerminalPanelProps {
  sessions: TerminalSession[];
  activeTermId: string | null;
  onSelect: (termId: string) => void;
  onCreate: () => void;
  onKill: (termId: string) => void;
  onMount: (termId: string, container: HTMLElement) => void;
  onRefit: (termId: string) => void;
}

export function TerminalPanel(props: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { activeTermId, onMount, onRefit } = props;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !activeTermId) return;
    el.innerHTML = "";
    onMount(activeTermId, el);
    const observer = new ResizeObserver(() => onRefit(activeTermId));
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeTermId, onMount, onRefit]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {props.sessions.map((session) => (
            <span
              key={session.id}
              className={cn(
                "group flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-[11px]",
                session.id === props.activeTermId
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50"
              )}
              onClick={() => props.onSelect(session.id)}
            >
              {session.name}
              <X
                className="h-3 w-3 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onKill(session.id);
                }}
              />
            </span>
          ))}
        </div>
        <motion.button
          whileTap={{ scale: 0.9 }}
          title="New terminal"
          onClick={props.onCreate}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </motion.button>
      </div>
      {props.activeTermId ? (
        <div ref={containerRef} className="min-h-0 flex-1 px-2 pb-2 pt-1" />
      ) : (
        <button
          onClick={props.onCreate}
          className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground hover:text-foreground"
        >
          <TerminalSquare className="h-6 w-6 opacity-60" />
          <span className="text-xs">Open a terminal</span>
        </button>
      )}
    </div>
  );
}
