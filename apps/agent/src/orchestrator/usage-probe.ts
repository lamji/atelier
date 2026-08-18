import { query } from "@anthropic-ai/claude-agent-sdk";
import type { UsageSnapshot, UsageWindow } from "@atelier/protocol";

/** Window ids the status bar knows how to label, in display order. */
const WINDOW_LABELS: Array<[string, string]> = [
  ["five_hour", "5h"],
  ["seven_day", "week"],
  ["seven_day_opus", "week · Opus"],
  ["seven_day_sonnet", "week · Sonnet"],
  ["seven_day_oauth_apps", "week · apps"],
];

interface RawWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

interface UsageResponse {
  rate_limits_available?: boolean;
  rate_limits?: Record<string, unknown> | null;
}

/** The control method is flagged experimental upstream — never assume it. */
type MaybeUsageQuery = {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<UsageResponse>;
  interrupt?: () => Promise<void>;
};

/**
 * Reads the data behind Claude Code's `/usage` — the plan rate-limit
 * windows — without running a turn: the session is opened in streaming
 * input mode and never fed a message, so only the control request runs.
 *
 * Returns null when plan limits do not apply (API key, Bedrock, Vertex)
 * or when the SDK does not expose the call; callers keep whatever the
 * live rate_limit_event feed gave them.
 */
export async function probeUsage(cwd: string): Promise<UsageSnapshot | null> {
  const clampPercent = (value: number): number =>
    Math.max(0, Math.min(100, Math.round(value * 10) / 10));

  const parseResetsAt = (iso: string | null | undefined): number | null => {
    if (!iso) return null;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : ms;
  };

  const toWindows = (limits: Record<string, unknown>): UsageWindow[] => {
    const windows: UsageWindow[] = [];
    for (const [kind, label] of WINDOW_LABELS) {
      const raw = limits[kind] as RawWindow | null | undefined;
      if (!raw || typeof raw.utilization !== "number") continue;
      windows.push({
        kind,
        label,
        utilization: clampPercent(raw.utilization),
        resetsAt: parseResetsAt(raw.resets_at),
      });
    }
    const scoped = limits.model_scoped;
    if (Array.isArray(scoped)) {
      for (const entry of scoped as Array<
        RawWindow & { display_name?: string }
      >) {
        if (typeof entry.utilization !== "number") continue;
        const name = entry.display_name ?? "model";
        windows.push({
          kind: `model:${name}`,
          label: `week · ${name}`,
          utilization: clampPercent(entry.utilization),
          resetsAt: parseResetsAt(entry.resets_at),
        });
      }
    }
    return windows;
  };

  const abort = new AbortController();
  // A prompt stream that yields nothing keeps the session idle: opening it
  // costs a process, not tokens.
  const idlePrompt = (async function* () {
    await new Promise<void>((resolve) => {
      abort.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  })();

  try {
    const session = query({
      prompt: idlePrompt as never,
      options: { cwd, abortController: abort, settingSources: [] },
    });
    const control = session as unknown as MaybeUsageQuery;
    const read = control.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof read !== "function") return null;

    const response = await read.call(session);
    if (!response?.rate_limits_available || !response.rate_limits) {
      return {
        available: false,
        status: null,
        windows: [],
        ollamaCloudUsage: [],
        updatedAt: Date.now(),
      };
    }
    return {
      available: true,
      status: null,
      windows: toWindows(response.rate_limits),
      ollamaCloudUsage: [],
      updatedAt: Date.now(),
    };
  } catch {
    return null;
  } finally {
    abort.abort();
  }
}

