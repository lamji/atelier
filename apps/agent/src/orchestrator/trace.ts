import fs from "node:fs";

/**
 * Opt-in latency trace, written as JSONL for `scripts/bench-chat.mjs`.
 *
 * The pipeline already publishes every stage duration on the event bus, but
 * those events are for the live rail: they are per-conversation, they are
 * dropped when nothing is listening, and there is nothing to diff a change
 * against afterwards. This writes the same numbers somewhere a script can
 * read them across many runs.
 *
 * Off unless ATELIER_TRACE names a file, so a normal turn pays one env
 * lookup that was resolved at import time. Sync appends on purpose: the
 * numbers are only worth anything if they land in the order they happened,
 * and a run with tracing on is a measurement run, not a user's.
 */
const FILE = process.env.ATELIER_TRACE?.trim();

export interface TraceEvent {
  /** "stage" | "first_token" | "turn" */
  kind: string;
  taskId: string;
  /** Stage name, for kind "stage". */
  stage?: string;
  /** Elapsed milliseconds this event is reporting. */
  ms: number;
  ok?: boolean;
  detail?: string;
}

export function trace(event: TraceEvent): void {
  if (!FILE) return;
  try {
    fs.appendFileSync(FILE, `${JSON.stringify({ at: Date.now(), ...event })}\n`);
  } catch {
    // A trace that cannot be written must never take the turn down with it.
  }
}

/** True when a run is being measured — lets callers skip optional work. */
export function tracing(): boolean {
  return Boolean(FILE);
}
