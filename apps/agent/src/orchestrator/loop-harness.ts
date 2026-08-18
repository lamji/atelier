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
    "This session continues until the gate closes. If a blocker is genuinely " +
      "outside your control (a guard refusal with no alternative path, an " +
      "approval the user cancelled), do everything else, then end with a line " +
      "starting `BLOCKED:` naming exactly what the user must resolve — that " +
      "is the only report the gate accepts while items remain open."
  );
  return lines.join("\n");
}

/** Recognises the one honest exit the harness offers a stuck model. */
export function reportsHardBlocker(text: string): boolean {
  return /(^|\n)\s*(\*\*)?BLOCKED:/m.test(text);
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
