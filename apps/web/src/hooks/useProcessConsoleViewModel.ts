import { useCallback, useEffect, useState } from "react";
import { useProcessConsoleStore } from "@/state/process-console.store";
import type { ConsoleLine } from "@/state/process-console.store";
import { useSessionsStore } from "@/state/sessions.store";

/** How often the idle clock re-reads, in ms. Seconds resolution is enough. */
const TICK_MS = 1000;

/**
 * Silence past this long, while a task is still running, is worth calling
 * out. Under it, a quiet console is just a validator thinking.
 */
const STALLED_AFTER_MS = 30_000;

export interface ProcessConsoleVm {
  lines: ConsoleLine[];
  /** Whether the selected session has a task in flight. */
  running: boolean;
  /** Seconds since the last output line, or null if nothing has arrived. */
  idleSeconds: number | null;
  /** Running, but nothing has been written for a while. */
  stalled: boolean;
  clear: () => void;
}

/**
 * The console pane's state: the streamed output of the selected session,
 * plus how long it has been silent.
 *
 * The idle clock is the point. A validator run and a hung process both show
 * an empty feed and a spinner; only the time since the last byte tells them
 * apart, so it ticks here rather than being derived at render.
 */
export function useProcessConsoleViewModel(): ProcessConsoleVm {
  const convId = useSessionsStore((s) => s.selectedId);
  // A task in flight, rather than the session's display status: the idle
  // clock is only meaningful while something could still be writing.
  const running = useSessionsStore((s) =>
    s.selectedId ? s.sessions[s.selectedId]?.activeTaskId != null : false
  );
  const entry = useProcessConsoleStore((s) =>
    convId ? s.byConversation[convId] : undefined
  );
  const clearConsole = useProcessConsoleStore((s) => s.clear);

  const lastAt = entry?.lastAt ?? null;
  const [now, setNow] = useState(() => Date.now());

  // Only ticks while there is something to measure — an idle session with no
  // output has nothing to recompute every second.
  useEffect(() => {
    if (lastAt === null || !running) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [lastAt, running]);

  const idleMs = lastAt === null ? null : Math.max(0, now - lastAt);

  const clear = useCallback(() => {
    if (convId) clearConsole(convId);
  }, [convId, clearConsole]);

  return {
    lines: entry?.lines ?? [],
    running,
    idleSeconds: idleMs === null ? null : Math.floor(idleMs / 1000),
    stalled: running && idleMs !== null && idleMs >= STALLED_AFTER_MS,
    clear,
  };
}
