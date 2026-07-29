import { useCallback, useEffect, useRef, useState } from "react";
import { retryConnection } from "@/services/project-switch";
import { useConnectionStore } from "@/state/connection.store";
import { useProjectsStore } from "@/state/projects.store";
import type { ConnectionState } from "@/types";
import { isDesktop } from "@/lib/desktop";

/** Why the workspace is unusable right now, outermost failure first. */
export type GateReason =
  | "supervisor-down"
  | "no-project"
  | "agent-down"
  | "agent-error"
  | "unauthorized";

/**
 * Trouble with no overlay of its own. A link that is mid-dial gets no screen
 * of its own — the status bar already shows it — but it still counts as
 * trouble internally (see the effect below).
 */
type Trouble = GateReason | "dialling";

/**
 * How long a reason must hold before it blocks the screen. Boot and project
 * switches sit in "dialling" for a while, so these only start counting once
 * something has actually failed. Terminal states have nothing to wait for.
 */
const BLOCK_DELAY_MS: Record<GateReason, number> = {
  "supervisor-down": 1200,
  "no-project": 1200,
  "agent-down": 1200,
  "agent-error": 0,
  unauthorized: 0,
};

interface Signals {
  bridge: ConnectionState;
  hub: ConnectionState;
  bootstrapping: boolean;
  switching: boolean;
  hasProject: boolean;
  projectStatus?: string;
}

/** True while a link is mid-dial — no verdict on it yet either way. */
function isDialling(state: ConnectionState): boolean {
  return state === "connecting" || state === "handshaking";
}

/**
 * The supervisor link is judged before the agent link: with the hub down we
 * know nothing about projects, so "Atelier isn't running" is the only honest
 * message.
 */
function deriveTrouble(s: Signals): Trouble | null {
  if (s.bridge === "connected") return null;
  if (s.bridge === "unauthorized" || s.hub === "unauthorized") {
    return "unauthorized";
  }
  if (s.hub === "disconnected") return "supervisor-down";
  if (isDialling(s.hub)) return "dialling";
  if (s.bootstrapping || s.switching) return "dialling";
  // Desktop has its own full-screen welcome (open / import a project);
  // the terminal-instruction gate is for the browser build only.
  if (!s.hasProject) return isDesktop() ? null : "no-project";
  if (s.projectStatus === "error") return "agent-error";
  if (s.projectStatus === "starting") return "dialling";
  if (isDialling(s.bridge)) return "dialling";
  return "agent-down";
}

/**
 * ViewModel for the full-screen connection gate: what is broken and how to
 * fix it. Returns reason === null whenever the workspace is usable, still
 * connecting, or only briefly in flux.
 */
export function useConnectionGateViewModel() {
  const bridge = useConnectionStore((s) => s.state);
  const hub = useProjectsStore((s) => s.hubState);
  const bootstrapping = useProjectsStore((s) => s.bootstrapping);
  const switching = useProjectsStore((s) => s.switching);
  const activeId = useProjectsStore((s) => s.activeId);
  const projects = useProjectsStore((s) => s.projects);

  const active = projects.find((p) => p.id === activeId);
  const trouble = deriveTrouble({
    bridge,
    hub,
    bootstrapping,
    switching,
    hasProject: activeId !== null,
    projectStatus: active?.status,
  });

  const [reason, setReason] = useState<GateReason | null>(null);
  const [retrying, setRetrying] = useState(false);

  const latest = useRef(trouble);
  latest.current = trouble;
  // The last thing that actually failed. A dead endpoint cycles
  // dialling -> failed -> dialling under reconnect backoff; when the
  // countdown lands on a dialling tick we show this instead, so the overlay
  // appears once and stays put rather than blinking with the retry loop.
  const lastFailure = useRef<GateReason | null>(null);
  if (trouble !== null && trouble !== "dialling") lastFailure.current = trouble;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Connected: drop everything, instantly.
    if (trouble === null) {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      lastFailure.current = null;
      setReason(null);
      return;
    }
    // Mid-dial: no overlay of its own, and deliberately no state change —
    // any countdown already running keeps running, and anything already on
    // screen stays on screen.
    if (trouble === "dialling") return;
    // Already blocking — refine the message without a second delay.
    if (reason !== null) {
      if (trouble !== reason) setReason(trouble);
      return;
    }
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const now = latest.current;
      const show = now === "dialling" || now === null ? lastFailure.current : now;
      if (show !== null) setReason(show);
    }, BLOCK_DELAY_MS[trouble]);
  }, [trouble, reason]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      await retryConnection();
    } finally {
      setRetrying(false);
    }
  }, []);

  return {
    reason,
    /** Folder name of the project we are trying to reach, when known. */
    projectName: active?.name ?? null,
    /** Absolute path, so the overlay can show a copyable `cd` command. */
    projectPath: active?.path ?? null,
    /** Supervisor-reported failure detail for a crashed agent. */
    detail: active?.error ?? null,
    retry,
    retrying,
    reload: () => window.location.reload(),
  };
}

export type ConnectionGateVm = ReturnType<typeof useConnectionGateViewModel>;
