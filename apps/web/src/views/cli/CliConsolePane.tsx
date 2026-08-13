import { useEffect, useRef, useState } from "react";
import {
  FilePlus2,
  Loader2,
  Plus,
  RotateCcw,
  TerminalSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { droppedFilePaths } from "@/lib/desktop";
import { terminalRegistry } from "@/services/terminal-registry";
import {
  ensureCliSessions,
  useCliConsoleStore,
} from "@/services/cli-console";
import { ChangesRail } from "@/views/chat/ChangesRail";
import { useGitChangesRailViewModel } from "@/hooks/useGitChangesRailViewModel";
import { useConnectionStore } from "@/state/connection.store";
import { useThemeStore } from "@/state/theme.store";

/**
 * CLI mode's main console: the real provider CLI running in a pty where the
 * chat transcript normally is. Atelier injects nothing — no retrieval, no
 * plan, no review, no memory — the user gets the CLI's own default flow, as
 * is. The left column lists these CLI sessions instead of the chat ones
 * (see CliSessionListPanel); the chats themselves are untouched, and
 * switching the mode back off returns to them exactly as they were.
 *
 * The changes rail stays beside it. The CLI writes to disk itself, so its
 * edits never reach the agent's diff pipeline — the rail reads the working
 * tree instead ({@link useGitChangesRailViewModel}) and is always on screen,
 * because in this mode it is the only place the user sees what changed. It
 * follows the selected session and shows only what that session changed, so
 * a session that has touched nothing shows nothing.
 */
export function CliConsolePane() {
  const connected = useConnectionStore((s) => s.state === "connected");
  const sessions = useCliConsoleStore((s) => s.sessions);
  const selectedId = useCliConsoleStore((s) => s.selectedId);
  const changes = useGitChangesRailViewModel(selectedId);
  const bootstrapped = useCliConsoleStore((s) => s.bootstrapped);
  const openProviderPicker = useCliConsoleStore((s) => s.openProviderPicker);
  const [error, setError] = useState<string | null>(null);
  const cliLoading = connected && !bootstrapped && !error;
  /** True while a drag carrying files is over the pane, for the drop hint. */
  const [dragActive, setDragActive] = useState(false);

  // One persistent DOM container per session, mounted for the session's
  // whole life: switching sessions only toggles visibility, so scrollback
  // and the running process survive. Same contract as the terminal dock.
  const containers = useRef<Map<string, HTMLDivElement>>(new Map());
  const mounted = useRef<Set<string>>(new Set());

  // Acquire (or reattach to) this workspace's CLI sessions, once per
  // connection. Reuse-first, so toggling the mode or reloading the window
  // lands back in the same running CLIs.
  useEffect(() => {
    if (!connected || bootstrapped) return;
    let cancelled = false;
    setError(null);
    ensureCliSessions().catch((cause) => {
      if (!cancelled) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [connected, bootstrapped]);

  // Open each xterm into its own container. The registry keeps the instance
  // (and its scrollback) alive across unmounts, so hiding the pane never
  // loses a session.
  useEffect(() => {
    const dark = useThemeStore.getState().theme === "dark";
    for (const session of sessions) {
      const el = containers.current.get(session.termId);
      if (el && !mounted.current.has(session.termId)) {
        mounted.current.add(session.termId);
        // These ptys exist to run a provider's own themed TUI, and on Windows
        // that TUI cannot find out the pane is light — ConPTY eats the OSC 11
        // query it asks with. So its dark surfaces are corrected on the way
        // in; see TuiSurfaceFilter.
        terminalRegistry.mount(session.termId, el, dark, {
          retintDarkSurfaces: true,
        });
      }
    }
    // Forget dead sessions so a reused id remounts cleanly.
    for (const id of [...mounted.current]) {
      if (!sessions.some((s) => s.termId === id)) mounted.current.delete(id);
    }
  }, [sessions]);

  // Refit and focus whichever session is showing. The observer fires on real
  // resizes AND when a container comes back from display:none, which is
  // exactly when a refit is needed.
  useEffect(() => {
    if (!selectedId) return;
    const el = containers.current.get(selectedId);
    if (!el) return;
    terminalRegistry.fitAndSync(selectedId);
    terminalRegistry.focus(selectedId);
    const observer = new ResizeObserver(() =>
      terminalRegistry.fitAndSync(selectedId)
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [selectedId]);

  /**
   * Drop files onto the pane to hand their paths to the running CLI.
   *
   * Any file, not just images: this is a terminal, and dropping a file into a
   * terminal types its path — that is the behaviour every provider's CLI
   * already builds on, whether the path turns into an image attachment, a
   * file to read, or an argument the user goes on to type around. The pty is
   * a real program's stdin, so pasting the path is also the ONLY channel
   * available; Atelier's own attachment plumbing does not reach in here.
   *
   * Trailing space, because the path is almost never the end of the sentence.
   */
  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragActive(false);
    if (!selectedId) return;
    const paths = droppedFilePaths(event.dataTransfer);
    if (paths.length === 0) return;
    const text = paths.map((p) => (p.includes(" ") ? `"${p}"` : p)).join(" ");
    terminalRegistry.pasteText(selectedId, `${text} `);
    terminalRegistry.focus(selectedId);
  };

  return (
    <div className="flex h-full min-h-0">
      {/* min-w-0: the rail's width is fixed chrome, so this column is the
          one that gives when the pane narrows — otherwise the terminal's
          own content width would push the rail off the right edge. */}
      <div
        className="relative min-h-0 min-w-0 flex-1 bg-panel dark:bg-editor"
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          // Without this the cursor reads "move", which is not what a drop
          // here does — nothing leaves where it came from.
          event.dataTransfer.dropEffect = "copy";
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node)) return;
          setDragActive(false);
        }}
        onDrop={handleDrop}
      >
        {sessions.map((session) => (
          <div
            key={session.termId}
            ref={(el) => {
              if (el) containers.current.set(session.termId, el);
              else containers.current.delete(session.termId);
            }}
            className={cn(
              "absolute inset-0 bg-panel p-2 dark:bg-editor",
              session.termId !== selectedId && "hidden"
            )}
          />
        ))}
        {(sessions.length === 0 || error) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-panel dark:bg-editor">
            {cliLoading ? (
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/50" />
            ) : (
              <TerminalSquare className="h-6 w-6 text-muted-foreground/50" />
            )}
            {error ? (
              <>
                <p className="max-w-md px-4 text-center text-xs text-destructive">
                  {error}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => useCliConsoleStore.getState().reset()}
                  className="!h-6 gap-1.5 px-2 py-0.5 text-[11px]"
                >
                  <RotateCcw className="h-3 w-3" />
                  Retry
                </Button>
              </>
            ) : bootstrapped ? (
              <>
                {/* Quitting the last CLI must not respawn one behind the
                    user's back, so the way back is a button. */}
                <p className="text-xs text-muted-foreground">
                  No CLI sessions open.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={openProviderPicker}
                  className="!h-6 gap-1.5 px-2 py-0.5 text-[11px]"
                >
                  <Plus className="h-3 w-3" />
                  New CLI session
                </Button>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                {connected
                  ? "Loading CLI sessions…"
                  : "Waiting for the agent…"}
              </p>
            )}
          </div>
        )}
        {dragActive && selectedId && (
          <div className="pointer-events-none absolute inset-2 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary bg-panel/90 dark:bg-editor/90">
            <FilePlus2 className="h-6 w-6 text-primary" />
            <p className="text-xs text-muted-foreground">
              Drop to paste the file path into the session
            </p>
          </div>
        )}
      </div>
      {/* Never conditional: the rail is the only diff surface in CLI mode,
          and a column that appears the first time the CLI touches a file
          would reflow the terminal at exactly the wrong moment. Empty until
          this session changes something — the column stays, its content
          does not. */}
      <ChangesRail
        vm={{ ...changes, loading: changes.loading || cliLoading }}
        status={null}
      />
    </div>
  );
}
