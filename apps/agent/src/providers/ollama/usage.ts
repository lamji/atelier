import type { SettingsRepo } from "../../storage/repositories/settings.js";

/**
 * Rolling meter for what Atelier spends on Ollama.
 *
 * Ollama Cloud exposes no usage or quota endpoint — plan limits (5-hourly
 * and weekly) are only visible on ollama.com/settings. What every response
 * does carry is token counts and GPU duration, so we accumulate those.
 *
 * This is therefore Atelier's own consumption, NOT the account total: any
 * other client hitting the same key spends quota this never sees. The UI
 * has to say so rather than imply it is the plan figure.
 */

const STORAGE_KEY = "ollamaUsageEvents";

/** Bounds the persisted array; 7 days of heavy use stays well under this. */
const MAX_EVENTS = 4000;

const HOUR_MS = 60 * 60 * 1000;
const FIVE_HOURS_MS = 5 * HOUR_MS;
const SEVEN_DAYS_MS = 7 * 24 * HOUR_MS;

export interface UsageEvent {
  /** Epoch ms. */
  t: number;
  /** Prompt tokens. */
  in: number;
  /** Generated tokens. */
  out: number;
  /** Total request duration in ms, as the daemon reported it. */
  ms: number;
}

export interface UsageWindowTotals {
  kind: string;
  label: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  seconds: number;
}

let events: UsageEvent[] = [];
let repo: SettingsRepo | null = null;

/**
 * Wires persistence and restores prior events.
 *
 * Called once per workspace, and one agent process now hosts several — so
 * the FIRST workspace to arrive owns the store and later ones are ignored.
 * That is the honest arrangement rather than a limitation: the Ollama key
 * is machine-wide, so its spend is machine-wide too, and letting each
 * workspace repoint this would have split one account's meter across
 * several databases and shown every project a fraction of the real total.
 */
export function initUsage(settings: SettingsRepo): void {
  if (repo) return;
  repo = settings;
  const raw = settings.getRaw(STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as UsageEvent[];
    events = Array.isArray(parsed) ? parsed.filter(isEvent) : [];
  } catch {
    events = [];
  }
  prune();
}

/**
 * Records one completed call. Nanosecond durations come straight from the
 * daemon; anything missing is recorded as zero rather than guessed.
 */
export function recordUsage(raw: {
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
  createdAt: number;
}): void {
  events.push({
    t: raw.createdAt,
    in: Math.max(0, Math.round(raw.prompt_eval_count ?? 0)),
    out: Math.max(0, Math.round(raw.eval_count ?? 0)),
    // total_duration is nanoseconds per Ollama's API docs.
    ms: Math.max(0, Math.round((raw.total_duration ?? 0) / 1_000_000)),
  });
  prune();
  persist();
}

/**
 * Totals over the two rolling windows that mirror Ollama's own plan
 * periods. Rolling, not plan-aligned — we cannot see when the account's
 * window actually resets, so nothing here claims to.
 */
export function usageWindows(now: number): UsageWindowTotals[] {
  return [
    total("five_hour", "last 5h", now - FIVE_HOURS_MS, now),
    total("seven_day", "last 7d", now - SEVEN_DAYS_MS, now),
  ];
}

function total(
  kind: string,
  label: string,
  from: number,
  now: number
): UsageWindowTotals {
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let ms = 0;
  for (const e of events) {
    if (e.t < from || e.t > now) continue;
    requests += 1;
    inputTokens += e.in;
    outputTokens += e.out;
    ms += e.ms;
  }
  return {
    kind,
    label,
    requests,
    inputTokens,
    outputTokens,
    seconds: Math.round(ms / 1000),
  };
}

/** Drops anything past the longest window, then caps the array. */
function prune(): void {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  events = events.filter((e) => e.t >= cutoff);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
}

function persist(): void {
  repo?.setRaw(STORAGE_KEY, JSON.stringify(events));
}

function isEvent(value: unknown): value is UsageEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<UsageEvent>;
  return typeof e.t === "number" && typeof e.in === "number";
}
