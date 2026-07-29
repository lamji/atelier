import { useEffect } from "react";
import { Activity, ChevronDown, TerminalSquare } from "lucide-react";
import { cn } from "@/lib/cn";
import { TerminalPanel } from "@/views/terminal/TerminalPanel";
import { TimelinePanel } from "@/views/timeline/TimelinePanel";
import type { TerminalSession } from "@atelier/protocol";
import type { BottomTab } from "@/state/workspace.store";
import type { TimelineEntryVm } from "@/types";

export interface BottomPanelProps {
  open: boolean;
  tab: BottomTab;
  onSelectTab: (tab: BottomTab) => void;
  onClose: () => void;
  // terminal — same viewmodel surface RightDock used to receive
  terminalSessions: TerminalSession[];
  activeTermId: string | null;
  onSelectTerm: (termId: string) => void;
  onCreateTerm: () => void;
  onKillTerm: (termId: string) => void;
  onMountTerm: (termId: string, container: HTMLElement) => void;
  onRefitTerm: (termId: string) => void;
  // timeline
  timelineEntries: TimelineEntryVm[];
}

const TABS: Array<{ id: BottomTab; label: string; icon: typeof Activity }> = [
  { id: "terminal", label: "Terminal", icon: TerminalSquare },
  { id: "timeline", label: "Timeline", icon: Activity },
];

/**
 * IDE-style bottom dock hosting the integrated terminal and the execution
 * timeline. It is the single permanent host of TerminalPanel: xterm
 * containers must never move between DOM parents, so this panel stays
 * mounted (collapsed to zero height) rather than unmounting.
 */
export function BottomPanel(props: BottomPanelProps) {
  const { open, tab, activeTermId, onRefitTerm } = props;

  // Re-fit the visible terminal whenever the dock opens or regains the
  // terminal tab — its container size changed while it was hidden.
  useEffect(() => {
    if (open && tab === "terminal" && activeTermId) {
      requestAnimationFrame(() => onRefitTerm(activeTermId));
    }
  }, [open, tab, activeTermId, onRefitTerm]);

  return (
    <div className="flex h-full flex-col border-t border-border bg-card">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => props.onSelectTab(id)}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded px-2 text-[11px]",
              "font-medium uppercase tracking-wide transition-colors",
              tab === id
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
        <button
          type="button"
          onClick={props.onClose}
          aria-label="Hide panel"
          title="Hide panel (Ctrl+`)"
          className="ml-auto rounded p-1 text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div className={cn("absolute inset-0", tab !== "terminal" && "hidden")}>
          <TerminalPanel
            sessions={props.terminalSessions}
            activeTermId={props.activeTermId}
            onSelect={props.onSelectTerm}
            onCreate={props.onCreateTerm}
            onKill={props.onKillTerm}
            onMount={props.onMountTerm}
            onRefit={props.onRefitTerm}
          />
        </div>
        {tab === "timeline" && (
          <div className="absolute inset-0">
            <TimelinePanel entries={props.timelineEntries} />
          </div>
        )}
      </div>
    </div>
  );
}
