import type { ValidationResult } from "@atelier/protocol";
import type { TaskSummary } from "./task-summary-store.js";

/**
 * Builds the compressed record of a finished task from data the summary
 * stage already has — no LLM call. ~150 tokens replaces the whole turn.
 */
export function buildTaskSummary(input: {
  taskId: string;
  conversationId: string;
  intentSummary: string;
  changedFiles: string[];
  validation: ValidationResult[];
  planGoal: string;
}): TaskSummary {
  const failed = input.validation.filter((v) => !v.ok);
  const outcome =
    input.validation.length === 0
      ? null
      : failed.length === 0
        ? "validation green"
        : `validation failing: ${failed.map((v) => v.kind).join(", ")}`;
  const lines = [input.intentSummary || input.planGoal];
  if (input.changedFiles.length > 0) {
    lines.push(`changed: ${input.changedFiles.slice(0, 6).join(", ")}`);
  }
  if (outcome) lines.push(outcome);
  return {
    taskId: input.taskId,
    conversationId: input.conversationId,
    text: lines.join(" · ").slice(0, 600),
    changedFiles: input.changedFiles.slice(0, 20),
    outcome,
    createdAt: Date.now(),
  };
}
