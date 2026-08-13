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

/** Atelier's default favors quota life; explicit user choices still win. */
export function claudeEffort(
  effort: ReasoningEffort | undefined
): Exclude<ReasoningEffort, "ultra"> | undefined {
  if (effort === "ultra") return undefined;
  return effort ?? "low";
}
