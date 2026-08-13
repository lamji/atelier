import type { SettingsRepo } from "../../storage/repositories/settings.js";

const STORAGE_KEY = "grokUsageEvents";
const MAX_EVENTS = 4000;
const HOUR_MS = 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * HOUR_MS;

interface UsageEvent { t: number; in: number; out: number; ms: number }
let events: UsageEvent[] = [];
let repo: SettingsRepo | null = null;

export function initGrokUsage(settings: SettingsRepo): void {
  if (repo) return;
  repo = settings;
  try {
    const parsed = JSON.parse(settings.getRaw(STORAGE_KEY) || "[]") as UsageEvent[];
    events = Array.isArray(parsed) ? parsed.filter(isEvent) : [];
  } catch {
    events = [];
  }
  prune();
}

export function recordGrokUsage(raw: {
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
}): void {
  events.push({
    t: Date.now(),
    in: Math.max(0, Math.round(raw.inputTokens ?? 0)),
    out: Math.max(0, Math.round(raw.outputTokens ?? 0)),
    ms: Math.max(0, Math.round(raw.durationMs)),
  });
  prune();
  try {
    repo?.setRaw(STORAGE_KEY, JSON.stringify(events));
  } catch {
    // Usage metering must never fail a model response.
  }
}

export function grokUsageWindows(now: number) {
  return [
    total("five_hour", "last 5h", now - 5 * HOUR_MS, now),
    total("seven_day", "last 7d", now - SEVEN_DAYS_MS, now),
  ];
}

function total(kind: string, label: string, from: number, now: number) {
  const found = events.filter((event) => event.t >= from && event.t <= now);
  return {
    kind,
    label,
    requests: found.length,
    inputTokens: found.reduce((sum, event) => sum + event.in, 0),
    outputTokens: found.reduce((sum, event) => sum + event.out, 0),
    seconds: Math.round(found.reduce((sum, event) => sum + event.ms, 0) / 1000),
  };
}

function prune(): void {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  events = events.filter((event) => event.t >= cutoff).slice(-MAX_EVENTS);
}

function isEvent(value: unknown): value is UsageEvent {
  const event = value as Partial<UsageEvent> | null;
  return Boolean(event && typeof event.t === "number" && typeof event.in === "number");
}
