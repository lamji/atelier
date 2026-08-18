import { memo, useEffect, useRef } from "react";
import { TerminalSquare } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  terminalProfile,
  type TerminalProfileId,
} from "@/services/terminal-appearance";
import { TerminalFindBar } from "./TerminalFindBar";
import type { TerminalSession } from "@atelier/protocol";

export interface TerminalPanelProps {
  sessions: TerminalSession[];
  activeTermId: string | null;
  profileId: TerminalProfileId;
  /** Whether the Ctrl+F find bar is showing for the active terminal. */
  searchOpen: boolean;
  onCreate: () => void;
  onMount: (termId: string, container: HTMLElement) => void;
  onRefit: (termId: string) => void;
  onCloseSearch: () => void;
}

/**
 * The persistent containers xterm renders into, and nothing else. Selecting
 * and closing terminals now happens in the dock's tab bar, so this component
 * owns only the surfaces. Memoized: output never flows through React (see
 * terminal-registry), so a shell re-render has no business walking this
 * subtree.
 */
export const TerminalPanel = memo(function TerminalPanel(
  props: TerminalPanelProps
) {
  const { sessions, activeTermId, onMount, onRefit } = props;
  const profile = terminalProfile(props.profileId);
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
    <div className="flex h-full flex-col" style={{ backgroundColor: profile.surface }}>
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
              style={{ backgroundColor: profile.surface }}
            />
          ))}
          {props.searchOpen && activeTermId && (
            <TerminalFindBar
              // Remounted per terminal: a find belongs to one scrollback.
              key={activeTermId}
              termId={activeTermId}
              onClose={props.onCloseSearch}
            />
          )}
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
