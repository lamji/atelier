import type {
  OllamaCloudUsageWindow,
  UsageSnapshot,
  UsageWindow,
} from "@atelier/protocol";
import type { EventBus } from "../events/event-bus.js";
import { probeUsage } from "./usage-probe.js";
import { usageWindows } from "../providers/ollama/usage.js";

/** Labels for windows learned from live events (the probe has its own). */
const EVENT_LABELS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "week",
  seven_day_opus: "week · Opus",
  seven_day_sonnet: "week · Sonnet",
  seven_day_overage_included: "week · overage",
  overage: "overage",
};

/** Idle refresh cadence — usage also moves when other clients run. */
const REFRESH_MS = 10 * 60_000;

/**
 * Keeps plan usage current from two sources:
 *
 *  - `rate_limit_event` messages the SDK emits mid-task, which move the
 *    number the moment this agent spends anything;
 *  - a periodic probe of the `/usage` control API, which also catches
 *    spend from other machines and from claude.ai itself.
 *
 * Every change publishes usage.updated, so the UI never polls.
 */
export class UsageMonitor {
  private snapshot: UsageSnapshot = {
    available: false,
    status: null,
    windows: [],
    ollamaCloudUsage: [],
    updatedAt: null,
  };
  private timer: NodeJS.Timeout | null = null;
  private probing = false;

  /** True while a task runs — the probe waits rather than compete. */
  private busy: () => boolean = () => false;

  constructor(
    private bus: EventBus,
    private workspaceRoot: string
  ) {}

  /** Set after the orchestrator exists (avoids a construction cycle). */
  setBusyProbe(busy: () => boolean): void {
    this.busy = busy;
  }

  get current(): UsageSnapshot {
    return this.snapshot;
  }

  /** Probe once now, then keep refreshing while the agent is idle. */
  start(): void {
    void this.refresh();
    this.timer = setInterval(() => {
      if (!this.busy()) void this.refresh();
    }, REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<UsageSnapshot> {
    if (this.probing) return this.snapshot;
    this.probing = true;
    try {
      const probed = await probeUsage(this.workspaceRoot);
      const ollamaCloudUsage = usageWindows(Date.now());
      if (probed) {
        this.publish({ ...probed, ollamaCloudUsage });
      } else {
        this.publish({
          ...this.snapshot,
          available: true,
          ollamaCloudUsage,
          updatedAt: Date.now(),
        });
      }
    } finally {
      this.probing = false;
    }
    return this.snapshot;
  }

  /**
   * Folds one SDK rate_limit_event into the snapshot. Events carry a
   * single window, so the others are kept as they were.
   */
  recordEvent(info: unknown): void {
    const event = (info ?? {}) as {
      status?: string;
      utilization?: number;
      resetsAt?: number;
      rateLimitType?: string;
    };
    const kind = event.rateLimitType;
    const status =
      event.status === "allowed" ||
      event.status === "allowed_warning" ||
      event.status === "rejected"
        ? event.status
        : null;
    if (!kind || typeof event.utilization !== "number") {
      if (status) this.publish({ ...this.snapshot, status });
      return;
    }
    const window: UsageWindow = {
      kind,
      label: EVENT_LABELS[kind] ?? kind,
      utilization: Math.max(0, Math.min(100, Math.round(event.utilization * 10) / 10)),
      resetsAt: typeof event.resetsAt === "number" ? event.resetsAt : null,
    };
    const windows = this.snapshot.windows.filter((w) => w.kind !== kind);
    windows.push(window);
    this.publish({
      available: true,
      status,
      windows,
      ollamaCloudUsage: usageWindows(Date.now()),
      updatedAt: Date.now(),
    });
  }

  private publish(next: UsageSnapshot): void {
    const snapshot: UsageSnapshot = { ...next, updatedAt: Date.now() };
    if (sameUsage(this.snapshot, snapshot)) return;
    this.snapshot = snapshot;
    this.bus.publish("usage.updated", snapshot);
  }
}

/** Ignores updatedAt: a re-probe with identical numbers is not news. */
function sameUsage(a: UsageSnapshot, b: UsageSnapshot): boolean {
  if (a.available !== b.available || a.status !== b.status) return false;
  if (a.windows.length !== b.windows.length) return false;
  const key = (w: UsageWindow) => `${w.kind}:${w.utilization}:${w.resetsAt}`;
  const left = a.windows.map(key).sort().join("|");
  const right = b.windows.map(key).sort().join("|");
  if (left !== right) return false;
  const cloudKey = (w: OllamaCloudUsageWindow) =>
    `${w.kind}:${w.requests}:${w.inputTokens}:${w.outputTokens}:${w.seconds}`;
  return (
    a.ollamaCloudUsage.map(cloudKey).sort().join("|") ===
    b.ollamaCloudUsage.map(cloudKey).sort().join("|")
  );
}
