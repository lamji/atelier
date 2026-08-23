/**
 * The loop that carries a Claude task past its own boundaries until the
 * live completion evidence says it is done.
 *
 * Two boundaries used to end a task early: the SDK turn ceiling (with two
 * bounded continuations of four rounds) and the completion gate (three
 * retries without progress). Both were caps on the TASK, when the only
 * thing worth capping is a STALL — a task that keeps landing edits and
 * checking steps off is doing exactly what it should, however many rounds
 * that takes. So the loop is progress-driven: every continuation that
 * moves the evidence earns the next one, and only consecutive rounds that
 * move nothing count against a stall limit.
 *
 * Each round also gets a HARNESS rather than a bare "keep going": the
 * exact outstanding items, the state so far, and every blocker the last
 * round hit (a guard refusal, a blocked hook, a failed tool). A model told
 * what stopped it can route around it; one told only "not done yet" tries
 * the same thing again — which is what "three retries" mostly bought.
 */

export interface LoopHarnessLimits {
  /** Consecutive gate rounds without progress before the loop stops. */
  gateStallLimit: number;
  /** Consecutive ceiling continuations without progress before it stops. */
  continuationStallLimit: number;
}

const DEFAULT_GATE_STALLS = 6;
const DEFAULT_CONTINUATION_STALLS = 3;

/**
 * Stall limits, overridable per machine: `ATELIER_GATE_STALL_LIMIT` and
 * `ATELIER_CONTINUATION_STALL_LIMIT`. Zero means "never stop for a stall"
 * — the loop then ends only on completion, cancellation, or a hard blocker
 * the model reports itself.
 */
export function loopHarnessLimits(env = process.env): LoopHarnessLimits {
  return {
    gateStallLimit: limitFrom(env.ATELIER_GATE_STALL_LIMIT, DEFAULT_GATE_STALLS),
    continuationStallLimit: limitFrom(
      env.ATELIER_CONTINUATION_STALL_LIMIT,
      DEFAULT_CONTINUATION_STALLS
    ),
  };
}

export interface StreamStallLimits {
  /** Silence after which the turn SAYS it has stalled. */
  warnMs: number;
  /** Silence after which the turn is aborted rather than left hanging. */
  abortMs: number;
}

const DEFAULT_STALL_WARN_MS = 180_000;
const DEFAULT_STALL_ABORT_MS = 900_000;

/**
 * How long a provider stream may say nothing at all.
 *
 * Nothing else bounds it. `maxTurns` bounds ROUNDS and the stall limits
 * above bound rounds that make no progress, but both need messages to
 * arrive: a stream that simply stops — a wedged subprocess, a dropped
 * connection, a tool that never returns — leaves the `for await` parked
 * forever with the UI still showing "Working". No timeout fires, no error
 * is published, and the turn can only be killed by hand.
 *
 * So silence is measured. At `warnMs` the status stops claiming progress
 * and names how long it has been quiet; at `abortMs` the session is
 * aborted so the turn ends as a reported failure. Generous by default,
 * because a long build or test run is legitimately quiet — and settable
 * per machine via `ATELIER_STREAM_WARN_MS` / `ATELIER_STREAM_ABORT_MS`,
 * where 0 means "never".
 */
export function streamStallLimits(env = process.env): StreamStallLimits {
  return {
    warnMs: limitFrom(env.ATELIER_STREAM_WARN_MS, DEFAULT_STALL_WARN_MS),
    abortMs: limitFrom(env.ATELIER_STREAM_ABORT_MS, DEFAULT_STALL_ABORT_MS),
  };
}

function limitFrom(raw: string | undefined, fallback: number): number {
  const value = Number(raw?.trim());
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value === 0 ? Infinity : Math.floor(value);
}

export interface HarnessState {
  /** The gate's own list of what is still open. */
  outstanding: string;
  changedFiles: string[];
  stepsDone: number;
  stepsTotal: number;
  /** Rounds so far, including this one. */
  attempt: number;
  /** Consecutive rounds that moved nothing, before this one. */
  stalled: number;
  /** Refusals and failures seen since the last round began, deduped. */
  blockers: string[];
}

/**
 * The prompt for one continuation round. Structured so the model can see
 * what is done, what is open, and what stopped it — and knows the one way
 * out that is not "try again": name a hard blocker as such.
 */
export function harnessPrompt(state: HarnessState): string {
  const lines: string[] = [state.outstanding.trim()];
  lines.push("");
  lines.push(
    `STATE SO FAR (round ${state.attempt}): ${state.stepsDone}/${state.stepsTotal} ` +
      `plan step(s) done · ${state.changedFiles.length} file(s) changed` +
      (state.changedFiles.length > 0
        ? ` (${state.changedFiles.slice(0, 8).join(", ")}${
            state.changedFiles.length > 8 ? ", …" : ""
          })`
        : "")
  );
  if (state.blockers.length > 0) {
    lines.push("BLOCKERS HIT IN THE LAST ROUND — do not repeat these calls as they were:");
    for (const blocker of state.blockers.slice(0, 8)) {
      lines.push(`- ${blocker}`);
    }
    lines.push(
      "Route around each one: a refused path means the file lives " +
        "elsewhere or must be reached another way (search for it, read the " +
        "same-named file inside the locked scope, or use a path the guard " +
        "accepts); a failed edit means the file changed — re-read it and " +
        "retry from its current text; a blocked command needs the approval " +
        "flow, not a rerun."
    );
  }
  if (state.stalled > 0) {
    lines.push(
      `The previous ${state.stalled} round(s) changed nothing. Do the next ` +
        "concrete step NOW — an edit, a step marked done, or a verification " +
        "run — before anything else."
    );
  }
  lines.push(
    "This session continues until the gate closes. Two reports — and only " +
      "these two — end it while items remain open. If a blocker is genuinely " +
      "outside your control (a guard refusal with no alternative path, an " +
      "approval the user cancelled), do everything else, then end with a line " +
      "starting `BLOCKED:` naming exactly what the user must resolve. If the " +
      "turn objectively needs no workspace change at all — the user stated a " +
      "fact, pasted output, corrected you, or the code already is what was " +
      "asked for — end with a line starting `NO CHANGE NEEDED:` giving the " +
      "reason in one sentence. Never use it to defer work you could do."
  );
  return lines.join("\n");
}

/** Recognises the honest exit for work only the user can unblock. */
export function reportsHardBlocker(text: string): boolean {
  return /(^|\n)\s*(\*\*)?BLOCKED:/m.test(text);
}

/**
 * Recognises the honest exit for a turn that owes no edit at all.
 *
 * Every other way the gate closes is evidence: a step marked done, a file
 * changed, a check that passed. A turn whose correct outcome is "nothing to
 * change here" — the user pasted output, stated a fact, corrected an earlier
 * claim, or the code already reads as asked — can produce none of that, so
 * without a declared exit it could only end by exhausting the stall budget,
 * and the user was then told the report "may describe work that is not
 * done". This is the sentence that ends such a turn cleanly. Like BLOCKED:
 * it must be a line of its own, so a passing mention cannot trip it.
 */
export function reportsNoChangeNeeded(text: string): boolean {
  return /(^|\n)\s*(\*\*)?NO CHANGE NEEDED:/m.test(text);
}

/**
 * Collects blockers from the bus for one round: what a tool refused or
 * failed, and what a hook blocked. Deduped by message, capped, and reset
 * at the start of the next round.
 */
export class BlockerLedger {
  private seen = new Map<string, number>();

  note(kind: string, message: string): void {
    const clipped = message.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!clipped) return;
    const key = `${kind}: ${clipped}`;
    this.seen.set(key, (this.seen.get(key) ?? 0) + 1);
  }

  /** Newest-first is not needed; the list is short and every item matters. */
  drain(): string[] {
    const items = [...this.seen.entries()].map(([key, count]) =>
      count > 1 ? `${key} (×${count})` : key
    );
    this.seen.clear();
    return items;
  }
}
