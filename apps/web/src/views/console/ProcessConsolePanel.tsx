import { useEffect, useLayoutEffect, useRef } from "react";
import { Eraser, TerminalSquare } from "lucide-react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { ProcessConsoleVm } from "@/hooks/useProcessConsoleViewModel";

/** Slack, in px, for calling the viewport "at the bottom" after rounding. */
const BOTTOM_EPSILON = 4;

export interface ProcessConsolePanelProps {
  vm: ProcessConsoleVm;
}

/**
 * Everything the agent runs, as it runs it.
 *
 * The process rail says which tool was called; this says what it printed.
 * Validators are the reason it exists — they are the longest stretch of a
 * task with nothing else to show, so a run that is working and a run that
 * has hung are indistinguishable without their output and the idle clock.
 */
export function ProcessConsolePanel({ vm }: ProcessConsolePanelProps) {
  const viewport = useRef<HTMLDivElement>(null);
  // Follows new output only while the user is already at the bottom, so
  // scrolling up to read is never yanked away — the terminal's own contract.
  const stick = useRef(true);

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stick.current = distance <= BOTTOM_EPSILON;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Before paint, so appended rows never flash at the old scroll position.
  useLayoutEffect(() => {
    if (stick.current && viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight;
    }
  }, [vm.lines]);

  return (
    <div className="flex h-full flex-col bg-editor">
      <header className="flex items-center gap-2 border-b border-border/60 px-4 py-2">
        <TerminalSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="text-xs font-semibold">Output</h2>
        <IdleClock vm={vm} />
        <span aria-hidden className="min-w-0 flex-1" />
        <Tooltip content="Clear output">
          <button
            type="button"
            onClick={vm.clear}
            disabled={vm.lines.length === 0}
            className={cn(
              "rounded p-1 text-muted-foreground transition-colors",
              "hover:text-foreground disabled:opacity-40",
              "disabled:hover:text-muted-foreground"
            )}
          >
            <Eraser className="h-4 w-4" />
            <span className="sr-only">Clear output</span>
          </button>
        </Tooltip>
      </header>

      <div
        ref={viewport}
        role="log"
        aria-label="Agent process output"
        className="min-h-0 flex-1 overflow-auto px-4 py-2 font-mono text-xs"
      >
        {vm.lines.length === 0 ? (
          <p className="text-muted-foreground">
            {vm.running
              ? "Waiting for the first output of this task…"
              : "Nothing has run in this session yet."}
          </p>
        ) : (
          vm.lines.map((line) => (
            <div
              key={line.id}
              className={cn(
                "whitespace-pre-wrap break-all leading-relaxed",
                // The agent opens every run with its own command line; it is
                // the only structure this stream has, so it carries the
                // emphasis that would otherwise need a separator row.
                line.text.startsWith("$ ")
                  ? "mt-2 font-semibold text-primary"
                  : "text-foreground/90"
              )}
            >
              {line.text || " "}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Time since the last byte. Silent by design when nothing is running or
 * output is flowing — it is only worth a line of the header when the answer
 * is "longer than you would expect".
 */
function IdleClock({ vm }: { vm: ProcessConsoleVm }) {
  if (!vm.running || vm.idleSeconds === null) return null;
  const label =
    vm.idleSeconds < 60
      ? `${vm.idleSeconds}s`
      : `${Math.floor(vm.idleSeconds / 60)}m ${vm.idleSeconds % 60}s`;
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px]",
        vm.stalled
          ? "bg-destructive/10 text-destructive"
          : "text-muted-foreground"
      )}
    >
      {vm.stalled ? `no output for ${label}` : `idle ${label}`}
    </span>
  );
}
