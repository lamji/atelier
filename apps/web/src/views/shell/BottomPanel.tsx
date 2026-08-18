import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Maximize2,
  Minimize,
  Minimize2,
  Palette,
  Plus,
  Search,
  TerminalSquare,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/tooltip";
import {
  TERMINAL_PROFILES,
  terminalProfile,
  type TerminalProfileId,
} from "@/services/terminal-appearance";
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
  terminalProfileId: TerminalProfileId;
  onTerminalProfileChange: (profile: TerminalProfileId) => void;
  onOpenTermSearch: () => void;
  onCloseTermSearch: () => void;
}

export function BottomPanel(props: BottomPanelProps) {
  const { open, activeTermId, onRefitTerm, onRenameTerm } = props;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [position, setPosition] = useState({ x: 220, y: 80 });
  const profile = terminalProfile(props.terminalProfileId);
  const rootRef = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const positionedRef = useRef(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const commitRename = useCallback(
    (termId: string, name: string) => {
      setRenaming(null);
      const trimmed = name.trim();
      if (trimmed) onRenameTerm(termId, trimmed);
    },
    [onRenameTerm]
  );

  const clampPosition = useCallback((next: { x: number; y: number }) => {
    const root = rootRef.current;
    const win = windowRef.current;
    if (!root || !win) return next;
    const pad = 12;
    const maxX = Math.max(pad, root.clientWidth - win.offsetWidth - pad);
    const maxY = Math.max(pad, root.clientHeight - win.offsetHeight - pad);
    return {
      x: Math.min(Math.max(pad, next.x), maxX),
      y: Math.min(Math.max(pad, next.y), maxY),
    };
  }, []);

  const beginDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (maximized || event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("button,input,[role='tab'],[role='tablist']")) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: position.x,
        originY: position.y,
      };
    },
    [maximized, position.x, position.y]
  );

  const moveDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      setPosition(
        clampPosition({
          x: drag.originX + event.clientX - drag.startX,
          y: drag.originY + event.clientY - drag.startY,
        })
      );
    },
    [clampPosition]
  );

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  useEffect(() => {
    if (open && activeTermId) {
      requestAnimationFrame(() => onRefitTerm(activeTermId));
    }
  }, [open, activeTermId, onRefitTerm, maximized]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      if (!positionedRef.current) {
        const root = rootRef.current;
        const win = windowRef.current;
        if (root && win) {
          setPosition({
            x: Math.max(12, Math.round((root.clientWidth - win.offsetWidth) / 2)),
            y: Math.max(12, Math.round((root.clientHeight - win.offsetHeight) / 2)),
          });
          positionedRef.current = true;
        }
      } else {
        setPosition((current) => clampPosition(current));
      }
    });
  }, [clampPosition, open]);

  return (
    <div
      ref={rootRef}
      className={cn(
        "pointer-events-none absolute z-40",
        maximized
          ? "inset-0"
          : [
              "left-3 right-3",
              "top-[calc(var(--topnav-h)_+_0.75rem)]",
              "bottom-[calc(var(--statusbar-h)_+_0.75rem)]",
            ],
        !open && "hidden"
      )}
    >
      <div
        ref={windowRef}
        role="dialog"
        aria-label="Terminal"
        className={cn(
          "pointer-events-auto absolute flex min-h-[18rem] flex-col overflow-hidden",
          "shadow-pop",
          maximized
            ? "inset-0 min-h-0 border-0"
            : [
                "h-[min(35rem,calc(100%_-_1.5rem))]",
                "w-[min(58rem,calc(100%_-_1.5rem))]",
                "rounded-2xl border border-border-subtle",
              ]
        )}
        style={{
          backgroundColor: profile.surface,
          ...(maximized ? {} : { left: position.x, top: position.y }),
        }}
      >
        <div
          className={cn(
            "flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle",
            "select-none px-3 text-[#f2f1ef]",
            maximized ? "cursor-default" : "cursor-move"
          )}
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          style={{ touchAction: "none", backgroundColor: profile.chrome }}
        >
          <div
            role="tablist"
            aria-label="Terminals"
            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
            onPointerDown={(event) => event.stopPropagation()}
          >
            {props.terminalSessions.map((session) => {
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
                    "group flex h-8 max-w-[14rem] shrink-0 cursor-pointer",
                    "items-center gap-1.5 rounded-xl pl-3 pr-1.5",
                    "text-xs font-medium transition-colors",
                    active
                      ? "text-white shadow-sm"
                      : "text-white/65 hover:text-white"
                  )}
                  style={active ? { backgroundColor: profile.tab } : undefined}
                >
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
                      title={`${session.name} - double-click to rename`}
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
                      "rounded-full opacity-0 transition-opacity hover:bg-white/10",
                      "hover:text-destructive focus-visible:opacity-100",
                      "group-hover:opacity-100",
                      active && "opacity-70"
                    )}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
            <Tooltip content="New terminal">
              <button
                type="button"
                onClick={props.onCreateTerm}
                aria-label="New terminal"
                className="tool-btn ml-0.5 shrink-0 text-white/75 hover:bg-white/10 hover:text-white"
              >
                <Plus className="h-4 w-4" />
              </button>
            </Tooltip>
          </div>
          <div
            className="flex shrink-0 items-center gap-0.5"
            onPointerDown={(event) => event.stopPropagation()}
          >
            {activeTermId && (
              <Tooltip content="Find in terminal (Ctrl+F)">
                <button
                  type="button"
                  onClick={props.onOpenTermSearch}
                  aria-label="Find in terminal"
                  className="tool-btn text-white/75 hover:bg-white/10 hover:text-white"
                >
                  <Search className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            )}
            <div className="relative">
              <Tooltip content="Terminal profile">
                <button
                  type="button"
                  onClick={() => setProfileOpen((value) => !value)}
                  aria-label="Terminal profile"
                  className="tool-btn text-white/75 hover:bg-white/10 hover:text-white"
                >
                  <Palette className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
              {profileOpen && (
                <div
                  className="absolute right-0 top-9 z-50 w-60 overflow-hidden rounded-xl border border-white/10 bg-[#151515] p-1 shadow-pop"
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  {Object.values(TERMINAL_PROFILES).map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => {
                        props.onTerminalProfileChange(option.id);
                        setProfileOpen(false);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-white/80 hover:bg-white/10 hover:text-white"
                    >
                      <span
                        className="h-4 w-4 rounded-full border border-white/20"
                        style={{ backgroundColor: option.surface }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{option.name}</span>
                        <span className="block truncate text-[11px] text-white/45">
                          {option.description}
                        </span>
                      </span>
                      {option.id === props.terminalProfileId && (
                        <Check className="h-3.5 w-3.5 text-white" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Tooltip content="Minimize terminal">
              <button
                type="button"
                onClick={props.onClose}
                aria-label="Minimize terminal"
                className="tool-btn text-white/75 hover:bg-white/10 hover:text-white"
              >
                <Minimize className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
            <Tooltip content={maximized ? "Restore terminal" : "Maximize terminal"}>
              <button
                type="button"
                onClick={() => setMaximized((value) => !value)}
                aria-label={maximized ? "Restore terminal" : "Maximize terminal"}
                className="tool-btn text-white/75 hover:bg-white/10 hover:text-white"
              >
                {maximized ? (
                  <Minimize2 className="h-3.5 w-3.5" />
                ) : (
                  <Maximize2 className="h-3.5 w-3.5" />
                )}
              </button>
            </Tooltip>
            <Tooltip content="Close terminal window">
              <button
                type="button"
                onClick={props.onClose}
                aria-label="Close terminal window"
                className="tool-btn text-white/75 hover:bg-white/10 hover:text-destructive"
              >
                <X className="h-3.5 w-3.5" />
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
            profileId={props.terminalProfileId}
            onCloseSearch={props.onCloseTermSearch}
          />
        </div>
      </div>
    </div>
  );
}

function TabNameInput(props: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(props.initial);
  const done = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
        "min-w-0 max-w-[8rem] flex-1 rounded-md border border-primary/60",
        "bg-card px-1.5 py-0 text-xs outline-none"
      )}
    />
  );
}
