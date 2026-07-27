import { memo, useEffect, useRef } from "react";
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

/**
 * Terminal tabs + the persistent containers xterm renders into. Memoized:
 * output never flows through React (see terminal-registry), so a shell
 * re-render has no business walking this subtree.
 */
export const TerminalPanel = memo(function TerminalPanel(
  props: TerminalPanelProps
) {
  const { sessions, activeTermId, onMount, onRefit } = props;
  // One persistent DOM container per terminal, kept mounted for the
  // terminal's whole life. Switching tabs only toggles visibility, so
  // scrollback and content survive; a theme toggle re-renders without
  // ever wiping or re-opening any terminal.
  const containers = useRef<Map<string, HTMLDivElement>>(new Map());
  const mounted = useRef<Set<string>>(new Set());

  // Mount each terminal once, into its own container.
  useEffect(() => {
    for (const session of sessions) {
      const el = containers.current.get(session.id);
      if (el && !mounted.current.has(session.id)) {
        mounted.current.add(session.id);
        onMount(session.id, el);
      }
    }
    // Forget terminals that no longer exist so a reused id remounts cleanly.
    for (const id of [...mounted.current]) {
      if (!sessions.some((s) => s.id === id)) mounted.current.delete(id);
    }
  }, [sessions, onMount]);

  // Refit the active terminal when it becomes visible / the panel resizes.
  useEffect(() => {
    if (!activeTermId) return;
    const el = containers.current.get(activeTermId);
    if (!el) return;
    onRefit(activeTermId);
    const observer = new ResizeObserver(() => onRefit(activeTermId));
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeTermId, onRefit]);

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
      {sessions.length > 0 ? (
        <div className="relative min-h-0 flex-1">
          {sessions.map((session) => (
            <div
              key={session.id}
              ref={(el) => {
                if (el) containers.current.set(session.id, el);
                else containers.current.delete(session.id);
              }}
              className={cn(
                "absolute inset-0 px-2 pb-2 pt-1",
                session.id !== activeTermId && "hidden"
              )}
            />
          ))}
        </div>
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
});
