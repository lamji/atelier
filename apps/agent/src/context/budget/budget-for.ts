import { BUDGETS, type ContextBudget } from "../types.js";

/** Resolve the token budget for an intent kind. */
export function budgetFor(kind: string): ContextBudget {
  if (kind === "question" || kind === "chat" || kind === "command") {
    return BUDGETS.light!;
  }
  if (kind === "feature" || kind === "refactor") return BUDGETS.feature!;
  return BUDGETS.edit!;
}
