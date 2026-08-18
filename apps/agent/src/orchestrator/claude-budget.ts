import type { ContextPurpose, ReasoningEffort } from "@atelier/protocol";

/**
 * Cheap native discovery only. `Task` launches additional Claude sessions,
 * multiplying five-hour usage behind one visible Atelier turn.
 */
export const CLAUDE_FAST_BUILTINS = ["Grep", "Glob"] as const;

/** Maximum Claude assistant/tool rounds for one SDK session. */
export function claudeTurnBudget(purpose: ContextPurpose): number {
  switch (purpose) {
    case "review":
      return 4;
    case "fix":
      return 6;
    case "plan":
      return 6;
    case "understand":
      return 4;
    case "execute":
    default:
      return 12;
  }
}

/**
 * Rounds granted to a session that spent its ceiling mid-work.
 *
 * A FULL session for execute work, not a wrap-up. Continuations used to
 * get four rounds on the theory that they only had to converge on an edit
 * already decided; in practice a large task ran out of ceiling mid-way,
 * got four rounds to "finish", ran out again, got four more, and then hit
 * the continuation cap with the gate open — a task-size cap wearing a
 * convergence budget's name. The loop is bounded by STALLS now (see
 * loop-harness.ts), so each continuation can afford the same room as the
 * session it continues. Review and repair rounds stay short: their whole
 * job fits in a few rounds and they run after the answer has streamed.
 */
export function claudeContinuationBudget(
  purpose: ContextPurpose,
  _unstarted = false
): number {
  return purpose === "execute" ? claudeTurnBudget("execute") : 6;
}

/**
 * How many consecutive continuations may move NOTHING before the loop
 * stops. Kept for callers that read it; the pipeline reads the same number
 * through loopHarnessLimits(), which the environment can raise or zero.
 */
export const CLAUDE_TURN_LIMIT_CONTINUATIONS = 3;

/**
 * Whether a thrown SDK error is just a spent ceiling.
 *
 * The CLI reports the ceiling as an error result and exits non-zero; the
 * SDK rethrows that exit carrying the result text ("Reached maximum number
 * of turns (12)"). There is no code on the error to match, so the text is
 * what there is to test. Every other error must keep propagating.
 */
export function isTurnLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /maximum number of turns/i.test(message);
}

/**
 * Yields a session's messages, absorbing the one failure that is not a
 * failure: a spent turn ceiling.
 *
 * Left alone, that throw unwinds the stage, the pipeline and the task —
 * losing the streamed answer, the summary and the session memory over a
 * ceiling Atelier chose itself, on a turn whose edits already landed. The
 * caller is told through `onTurnLimit` so it can continue the session
 * instead. Every other error still propagates untouched.
 */
export async function* tolerateTurnLimit<T>(
  stream: AsyncIterable<T>,
  onTurnLimit: () => void
): AsyncGenerator<T> {
  try {
    for await (const message of stream) yield message;
  } catch (error) {
    if (!isTurnLimitError(error)) throw error;
    onTurnLimit();
  }
}

/** Atelier's default favors quota life; explicit user choices still win. */
export function claudeEffort(
  effort: ReasoningEffort | undefined
): Exclude<ReasoningEffort, "ultra"> | undefined {
  if (effort === "ultra") return undefined;
  return effort ?? "low";
}
