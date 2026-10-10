import type { NamedTargets } from "./named-targets.js";

/**
 * How this turn relates to the one before it.
 *
 * Every Atelier turn runs on a fresh provider session, and continuity is
 * carried context: what was said, what was read, what was changed. That
 * context was written as if every earlier turn had gone well. It had not.
 * A user who stops a task and types "wait, I can still see the old label"
 * is REJECTING the last turn — but the next turn was handed its plan as
 * "changed: …", its reads as "you already hold these files", and a rule
 * saying "treat them as the answer". So it resumed the wrong work, three
 * turns in a row, and the user pasted the fix in by hand.
 *
 * - `continue`: the user asked to carry on ("continue", "go ahead", "yes").
 * - `correct`: the previous task was stopped, or the message says the last
 *   result was wrong. Carried findings are hints; the target is re-derived
 *   from the user's own words.
 * - `fresh`: an ordinary next request.
 */
export type TurnStance = "continue" | "correct" | "fresh";

export interface TurnStanceInput {
  humanPrompt: string;
  /** How the immediately preceding task in this conversation ended. */
  previousStatus?: "completed" | "cancelled" | "error" | null;
  named?: NamedTargets;
}

export interface TurnStanceResult {
  stance: TurnStance;
  /** Why, for the timeline and the tests. */
  reasons: string[];
}

/** "continue", "resume", "go ahead", "yes" — the user is not redirecting. */
const CONTINUE_CUES =
  /^\s*(?:ok(?:ay)?|yes|yep|yeah|sure|go|go on|go ahead|proceed|continue|resume|carry on|keep going|pick up|do it|just do it|apply it|implement( it)?|make it so|please do|sounds good|lgtm)\b[\s.!,]*$/i;

/**
 * Words that say the last result was wrong. Loose on purpose: a false
 * positive costs one turn's "do not re-investigate" saving; a false
 * negative costs the user another wrong edit.
 */
export const CORRECTION_CUES = new RegExp(
  [
    "\\bwrong\\b",
    "\\bnot (?:that|this|it|what i|the one|there)\\b",
    "\\bstill (?:see|seeing|shows?|showing|getting|there|not|the same|broken|wrong)\\b",
    "\\byou (?:keep|kept|changed|edited|touched|marked|fixed the wrong|broke)\\b",
    // A regression that happened is a complaint; "avoid regression" in a
    // spec is a goal, and it once turned a fresh design into a "correct".
    "(?<!\\bavoid\\w* |\\bprevent\\w* |\\bwithout |\\bno |\\bzero )\\bregressions?\\b",
    "\\brevert\\b",
    "\\bundo\\b",
    "\\b(?:not|isn'?t|wasn'?t|didn'?t|never) (?:fixed|fix|working|applied|changed)\\b",
    "\\bwhere (?:can i|are|is) (?:find |see )?(?:the |your )?(?:changes?|fix|edit)\\b",
    "\\bwhy (?:can'?t|cant|didn'?t|don'?t|won'?t) you\\b",
    "\\b(?:nope|no[,.!]|wait\\b|hold on)",
    "\\bthat'?s not\\b",
    "\\bi (?:said|asked|meant|told you)\\b",
    "\\bgo here\\b",
    "\\bare you (?:considering|even)\\b",
  ].join("|"),
  "i"
);

export function turnStance(input: TurnStanceInput): TurnStanceResult {
  const human = input.humanPrompt.trim();
  const reasons: string[] = [];
  if (CONTINUE_CUES.test(human)) {
    return { stance: "continue", reasons: ["the message is a go-ahead"] };
  }
  if (CORRECTION_CUES.test(human)) {
    reasons.push("the message says the last result was wrong");
  }
  if (input.previousStatus === "cancelled") {
    reasons.push("the previous task was stopped by the user");
  } else if (input.previousStatus === "error") {
    reasons.push("the previous task ended in error");
  }
  if (reasons.length > 0) return { stance: "correct", reasons };
  return { stance: "fresh", reasons: [] };
}
