import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Maximize2,
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
  followsAppTheme,
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

/** Panel height survives closing the panel and reloading the app, the way
 *  an editor's panel is expected to stay where it was dragged. */
const HEIGHT_KEY = "atelier.terminal.height";
const DEFAULT_HEIGHT = 320;
/** Below this the tab strip plus a couple of rows stop fitting. */
const MIN_HEIGHT = 140;
/** Always leave this much of the editor above the panel. */
const MIN_CONTENT_ABOVE = 180;

function readHeight(): number {
  const raw = Number(localStorage.getItem(HEIGHT_KEY));
  return Number.isFinite(raw) && raw >= MIN_HEIGHT ? raw : DEFAULT_HEIGHT;
}

/**
 * The workbench panel: docked along the bottom of the editor area, full
 * width, resized by dragging its top edge — not a floating window. It was
 * a draggable dialog before, which meant it covered the code it was run
 * against and had to be moved out of the way by hand.
 *
 * Maximizing takes over the whole region between the header and the status
 * bar (the editor collapses behind it) rather than opening a separate
 * surface, so the terminal, its tabs and its scrollback are the same DOM in
 * both modes and nothing re-mounts on the way in or out.
 */
export function BottomPanel(props: BottomPanelProps) {
  const { open, activeTermId, onRefitTerm, onRenameTerm } = props;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [height, setHeight] = useState(readHeight);
  const [resizing, setResizing] = useState(false);
  const profile = terminalProfile(props.terminalProfileId);
  /*
   * The fixed profiles are dark palettes, so the panel's chrome is written
   * white-on-dark. "Match the app" can be either, and white text on a light
   * surface is simply gone — so the chrome swaps to the shell's own tokens
   * whenever the terminal is following the theme rather than setting one.
   */
  const themed = followsAppTheme(props.terminalProfileId);
  const chromeText = themed ? "text-foreground" : "text-[#f2f1ef]";
  const mutedText = themed ? "text-muted-foreground" : "text-white/55";
  const activeText = themed ? "text-foreground" : "text-white";
  const hoverText = themed
    ? "hover:text-foreground"
    : "hover:text-white/85";
  const toolText = themed
    ? "text-muted-foreground hover:bg-accent hover:text-foreground"
    : "text-white/70 hover:bg-white/10 hover:text-white";
  const activeTab = themed ? "bg-accent/60" : "bg-white/[0.07]";
  const closeHover = themed ? "hover:bg-accent" : "hover:bg-white/15";
  const resizeRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);

  const commitRename = useCallback(
    (termId: string, name: string) => {
      setRenaming(null);
      const trimmed = name.trim();
      if (trimmed) onRenameTerm(termId, trimmed);
    },
    [onRenameTerm]
  );

  const clampHeight = useCallback((next: number) => {
    const ceiling = Math.max(
      MIN_HEIGHT,
      window.innerHeight - MIN_CONTENT_ABOVE
    );
    return Math.round(Math.min(Math.max(MIN_HEIGHT, next), ceiling));
  }, []);

  // ── Top-edge resize ────────────────────────────────────────────────────
  const beginResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (maximized || event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      resizeRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight: height,
      };
      setResizing(true);
    },
    [height, maximized]
  );

  const moveResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = resizeRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      // Dragging UP grows the panel, so the delta is inverted.
      setHeight(clampHeight(drag.startHeight - (event.clientY - drag.startY)));
    },
    [clampHeight]
  );

  const endResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(HEIGHT_KEY, String(height));
  }, [height]);

  // A window that shrank below the stored height leaves the panel taller
  // than the editor it is docked into.
  useEffect(() => {
    const onWindowResize = () => setHeight((current) => clampHeight(current));
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, [clampHeight]);

  // xterm measures its own container, so every change of the panel's box
  // (opening, maximizing, dragging the edge) needs a refit afterwards.
  useEffect(() => {
    if (open && activeTermId) {
      requestAnimationFrame(() => onRefitTerm(activeTermId));
    }
  }, [open, activeTermId, onRefitTerm, maximized, height]);

  return (
    <div
      role="region"
      aria-label="Panel"
      className={cn(
        "flex shrink-0 flex-col overflow-hidden border-t border-border-subtle",
        maximized && "absolute inset-0 z-40",
        !open && "hidden"
      )}
      style={{
        backgroundColor: profile.surface,
        ...(maximized ? {} : { height }),
      }}
    >
      {/* ── Resize edge ── VS Code's panel is sized from its own top border,
          so the grip is the border rather than a separate bar. */}
      <div
        role="separator"
        aria-label="Resize panel"
        aria-orientation="horizontal"
        onPointerDown={beginResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onDoubleClick={() => setHeight(DEFAULT_HEIGHT)}
        className={cn(
          "h-1 shrink-0 transition-colors",
          maximized ? "pointer-events-none" : "cursor-row-resize",
          resizing ? "bg-primary/70" : "hover:bg-primary/40"
        )}
        style={{ touchAction: "none" }}
      />

      {/* ── Tab strip ── */}
      <div
        className={cn(
          "flex h-9 shrink-0 select-none items-center gap-1 pl-3 pr-1.5",
          chromeText
        )}
        style={{ backgroundColor: profile.chrome }}
      >
        <span
          className={cn(
            "mr-2 shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em]",
            themed ? "text-muted-foreground/70" : "text-white/45"
          )}
        >
          Terminal
        </span>
        <div
          role="tablist"
          aria-label="Terminals"
          className="flex h-full min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto"
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
                  "group flex h-full max-w-[14rem] shrink-0 cursor-pointer",
                  "items-center gap-1.5 border-b-2 px-2.5",
                  "text-xs transition-colors",
                  active
                    ? `border-primary ${activeTab} ${activeText}`
                    : `border-transparent ${mutedText} ${hoverText}`
                )}
              >
                <TerminalSquare className="h-3.5 w-3.5 shrink-0 opacity-70" />
                {renaming === session.id ? (
                  <TabNameInput
                    initial={session.name}
                    onCommit={(name) => commitRename(session.id, name)}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <span
                    className="truncate"
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
                    "ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center",
                    `rounded opacity-0 transition-opacity ${closeHover}`,
                    "hover:text-destructive focus-visible:opacity-100",
                    "group-hover:opacity-100",
                    active && "opacity-60"
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
              className={cn("tool-btn ml-0.5 shrink-0", toolText)}
            >
              <Plus className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>

        {/* ── Panel actions ── */}
        <div className="flex shrink-0 items-center gap-0.5">
          {activeTermId && (
            <Tooltip content="Find in terminal (Ctrl+F)">
              <button
                type="button"
                onClick={props.onOpenTermSearch}
                aria-label="Find in terminal"
                className={cn("tool-btn", toolText)}
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
                className={cn("tool-btn", toolText)}
              >
                <Palette className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
            {profileOpen && (
              <div className="absolute right-0 top-8 z-50 w-60 overflow-hidden rounded-xl border border-white/10 bg-[#151515] p-1 shadow-pop">
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
                      className={cn(
                        "h-4 w-4 rounded-full border",
                        themed ? "border-border" : "border-white/20"
                      )}
                      style={{ backgroundColor: option.surface }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{option.name}</span>
                      <span
                        className={cn(
                          "block truncate text-[11px]",
                          themed ? "text-muted-foreground" : "text-white/45"
                        )}
                      >
                        {option.description}
                      </span>
                    </span>
                    {option.id === props.terminalProfileId && (
                      <Check
                        className={cn(
                          "h-3.5 w-3.5",
                          themed ? "text-primary" : "text-white"
                        )}
                      />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Tooltip
            content={maximized ? "Restore panel size" : "Maximize panel"}
          >
            <button
              type="button"
              onClick={() => setMaximized((value) => !value)}
              aria-label={maximized ? "Restore panel size" : "Maximize panel"}
              className={cn("tool-btn", toolText)}
            >
              {maximized ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
            </button>
          </Tooltip>
          <Tooltip content="Hide panel">
            <button
              type="button"
              onClick={props.onClose}
              aria-label="Hide panel"
              className={cn("tool-btn", toolText)}
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
          profileId={props.terminalProfileId}
          onCloseSearch={props.onCloseTermSearch}
        />
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
