import { useEffect, useState } from "react";
import { useConnectionStore } from "@/state/connection.store";
import { useProjectsStore } from "@/state/projects.store";

/**
 * One step of bringing a workspace's agent up, as the renderer can see it.
 * `from` is where the bar stands when the step is reached; it creeps toward
 * `to` while the step runs, and only the next real milestone moves it past.
 */
interface ConnectStep {
  label: string;
  from: number;
  to: number;
}

const STEPS = {
  host: { label: "Starting the agent", from: 4, to: 34 },
  workspace: { label: "Opening the workspace", from: 35, to: 74 },
  attach: { label: "Attaching to the agent", from: 75, to: 89 },
  handshake: { label: "Handshaking", from: 90, to: 98 },
} satisfies Record<string, ConnectStep>;

/**
 * Which step the open is on. The milestones are the real ones: the project
 * turns "starting" once the agent host is up, "running" once the workspace
 * has opened in it, `switching` clears once the port is attached, and the
 * bridge reports "connected" on the agent's ready frame.
 */
function currentStep(
  status: AtelierProjectInfo["status"] | undefined,
  switching: boolean
): ConnectStep {
  if (!switching) return STEPS.handshake;
  if (status === "running") return STEPS.attach;
  if (status === "starting") return STEPS.workspace;
  return STEPS.host;
}

/** Each tick closes this share of the gap to the step's ceiling. */
const CREEP = 0.06;
const TICK_MS = 120;

export interface ConnectProgress {
  percent: number;
  label: string;
}

/** Progress of opening the active workspace's agent, 0-100. */
export function useConnectProgress(): ConnectProgress {
  const connected = useConnectionStore((s) => s.state === "connected");
  const switching = useProjectsStore((s) => s.switching);
  const status = useProjectsStore(
    (s) => s.projects.find((p) => p.id === s.activeId)?.status
  );
  const step = currentStep(status, switching);
  const [value, setValue] = useState(step.from);

  useEffect(() => {
    if (connected) {
      setValue(100);
      return;
    }
    // Never move backwards: a step reached early keeps the bar where it is.
    setValue((v) => Math.max(v, step.from));
    const timer = setInterval(() => {
      setValue((v) => (v >= step.to ? v : v + (step.to - v) * CREEP));
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [connected, step]);

  return {
    percent: Math.round(value),
    label: connected ? "Connected" : step.label,
  };
}
