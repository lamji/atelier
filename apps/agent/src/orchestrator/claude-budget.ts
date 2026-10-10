import type { ContextPurpose, ReasoningEffort } from "@atelier/protocol";

/**
 * Cheap native discovery only. `Task` launches additional Claude sessions,
 * multiplying five-hour usage behind one visible Atelier turn.
 */
export const CLAUDE_FAST_BUILTINS = ["Grep", "Glob"] as const;

/**
 * The native file and shell tools, offered beside Atelier's MCP tools.
 * These are what the model is trained on; gated by the user's hooks
 * through PipelineExecutor.nativeToolHooks, never refused for process.
 */
export const CLAUDE_NATIVE_TOOLS = [
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "Bash",
  // Subagents: a broad investigation runs in its own context and reports
  // back a summary, so sixty file reads do not fill the main window.
  "Agent",
] as const;

/**
 * Subagents the main turn may delegate to. An investigation in a separate
 * context is the documented answer to "the model read hundreds of files
 * and filled its window"; the reviewer is the fresh pair of eyes that is
 * not biased toward code it just wrote.
 */
export const ATELIER_AGENTS = {
  investigator: {
    description:
      "Read-only codebase investigation: find where something is " +
      "implemented, trace a flow, or gather the exact file:line evidence " +
      "for a change. Use for any question that needs many file reads.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    prompt:
      "You investigate a codebase for the main agent. Read and search as " +
      "much as needed, then report ONLY what matters: the relevant files " +
      "with exact line numbers, how the pieces connect, and anything that " +
      "contradicts the question's assumptions. No preamble, no advice on " +
      "process — findings, in under 400 words.",
  },
  reviewer: {
    description:
      "Fresh-context review of a diff or a set of changed files against " +
      "the stated requirement. Use before reporting a non-trivial change " +
      "as done.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    prompt:
      "You review changes another agent made. Read the changed files and " +
      "the requirement, run the narrowest check that proves or disproves " +
      "them (a test, a typecheck, a build), and report only gaps that " +
      "affect correctness or the stated requirement — with file:line and " +
      "the evidence. If the work is sound, say so in one line.",
  },
} as const;

/**
 * Maximum Claude assistant/tool rounds for one SDK session.
 *
 * Execute used to stop at 12. An investigation of any size ran past it,
 * was restarted from a checkpoint, re-opened the files it had already
 * read, and hit the ceiling again — eight restarts and 4.3M tokens on one
 * task where a single session would have read each file once. The CLI
 * has no such ceiling; this one is a safety net against a runaway loop,
 * not a budget, and the stall limit in loopHarnessLimits() is what ends
 * a session that stops making progress.
 */
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
      return 40;
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
  // Unset used to mean "low" — the cheapest reasoning on every turn whose
  // composer left the picker alone, which was every turn. High is the
  // default; the picker goes lower for speed or to max for the hardest work.
  return effort ?? "high";
}
