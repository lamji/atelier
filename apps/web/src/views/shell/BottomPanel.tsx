import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, Search, TerminalSquare, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { TerminalPanel } from "@/views/terminal/TerminalPanel";
import type { TerminalSession } from "@atelier/protocol";

export interface BottomPanelProps {
  open: boolean;
  onClose: () => void;
  terminalSessions: TerminalSession[];
  activeTermId: string | null;
  onSelectTerm: (termId: string) => void;
  onCreateTerm: () => void;
  onKillTerm: (termId: string) => void;
  onRenameTerm: (termId: string, name: string) => void;
  onMountTerm: (termId: string, container: HTMLElement) => void;
  onRefitTerm: (termId: string) => void;
  termSearchOpen: boolean;
  onOpenTermSearch: () => void;
  onCloseTermSearch: () => void;
}

/**
 * The integrated terminal dock.
 *
 * Its bar IS the terminal tab strip — one row, the way a terminal app does it,
 * rather than a panel tab that then contains another tab row. It is the single
 * permanent host of TerminalPanel: xterm containers must never move between
 * DOM parents, so this panel stays mounted (collapsed to zero height) rather
 * than unmounting.
 *
 * The execution timeline used to be a second tab here. It is a full-height
 * feed, not a terminal, so it moved to the editor area's Activity pane.
 */
export function BottomPanel(props: BottomPanelProps) {
  const { open, activeTermId, onRefitTerm, onRenameTerm } = props;
  /** Terminal whose tab is currently being renamed in place. */
  const [renaming, setRenaming] = useState<string | null>(null);

  const commitRename = useCallback(
    (termId: string, name: string) => {
      setRenaming(null);
      const trimmed = name.trim();
      if (trimmed) onRenameTerm(termId, trimmed);
    },
    [onRenameTerm]
  );

  // Re-fit the visible terminal whenever the dock opens — its container size
  // changed while it was hidden.
  useEffect(() => {
    if (open && activeTermId) {
      requestAnimationFrame(() => onRefitTerm(activeTermId));
    }
  }, [open, activeTermId, onRefitTerm]);

  return (
    <div className="flex h-full flex-col border-t border-border bg-panel">
      <div
        className="flex shrink-0 items-stretch border-b border-border-subtle pr-1"
        style={{ height: "var(--tabbar-h)" }}
      >
        <div
          role="tablist"
          aria-label="Terminals"
          className="flex min-w-0 flex-1 items-stretch overflow-x-auto"
        >
          {props.terminalSessions.length === 0 ? (
            <span className="flex items-center gap-1.5 px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <TerminalSquare className="h-3.5 w-3.5" />
              Terminal
            </span>
          ) : (
            props.terminalSessions.map((session) => {
              const active = session.id === props.activeTermId;
              return (
                <div
                  key={session.id}
                  role="tab"
                  tabIndex={0}
                  aria-selected={active}
                  onClick={() => props.onSelectTerm(session.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      props.onSelectTerm(session.id);
                    }
                  }}
                  className={cn(
                    "group relative flex max-w-[14rem] shrink-0 cursor-pointer",
                    "items-center gap-1.5 border-r border-border-subtle pl-3 pr-1.5",
                    "text-xs transition-colors",
                    active
                      ? "bg-editor text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "absolute inset-x-0 top-0 h-[2px] bg-primary transition-opacity",
                      active ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <TerminalSquare className="h-3.5 w-3.5 shrink-0 opacity-80" />
                  {renaming === session.id ? (
                    <TabNameInput
                      initial={session.name}
                      onCommit={(name) => commitRename(session.id, name)}
                      onCancel={() => setRenaming(null)}
                    />
                  ) : (
                    <span
                      className="truncate"
                      // Double-click to rename is the terminal-app
                      // convention; the context menu is not built here, so
                      // the title spells it out.
                      title={`${session.name} — double-click to rename`}
                      onDoubleClick={() => setRenaming(session.id)}
                    >
                      {session.name}
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={`Close ${session.name}`}
                    title={`Close ${session.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onKillTerm(session.id);
                    }}
                    className={cn(
                      "ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center",
                      "rounded opacity-0 transition-opacity hover:bg-accent",
                      "hover:text-destructive focus-visible:opacity-100",
                      "group-hover:opacity-100",
                      active && "opacity-70"
                    )}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })
          )}

          {/* New tab sits directly after the last one, terminal-app style. */}
          <Tooltip content="New terminal">
            <button
              type="button"
              onClick={props.onCreateTerm}
              aria-label="New terminal"
              className="tool-btn my-auto ml-1 shrink-0"
            >
              <Plus className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {activeTermId && (
            <Tooltip content="Find in terminal (Ctrl+F)">
              <button
                type="button"
                onClick={props.onOpenTermSearch}
                aria-label="Find in terminal"
                className="tool-btn"
              >
                <Search className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          )}
          <Tooltip content="Hide panel (Ctrl+`)">
            <button
              type="button"
              onClick={props.onClose}
              aria-label="Hide panel"
              className="tool-btn"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <TerminalPanel
          sessions={props.terminalSessions}
          activeTermId={props.activeTermId}
          onCreate={props.onCreateTerm}
          onMount={props.onMountTerm}
          onRefit={props.onRefitTerm}
          searchOpen={props.termSearchOpen}
          onCloseSearch={props.onCloseTermSearch}
        />
      </div>
    </div>
  );
}

/**
 * The inline editor a tab becomes while being renamed. Blur commits, the way
 * the file explorer's rename row behaves, so clicking away keeps your typing
 * instead of quietly discarding it; Escape is the discard.
 */
function TabNameInput(props: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(props.initial);
  const done = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus and select once, on mount. A ref callback would re-run on every
  // render and re-select after each keystroke, so only one letter survived.
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
      aria-label="Terminal name"
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      // The tab under this input selects and closes on clicks and keys.
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
        "min-w-0 max-w-[8rem] flex-1 rounded-sm border border-primary/60",
        "bg-input/60 px-1 py-0 text-xs outline-none"
      )}
    />
  );
}
