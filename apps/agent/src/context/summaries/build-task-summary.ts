import type { ValidationResult } from "@atelier/protocol";
import type { SessionDetail, TaskSummary } from "./task-summary-store.js";

/** How a task ended. An interrupted task is still worth remembering. */
export type TaskOutcomeStatus = "completed" | "cancelled" | "error";

export interface BuildTaskSummaryInput {
  taskId: string;
  conversationId: string;
  intentSummary: string;
  /** Exact request, retained so terse later turns can retrieve its details. */
  originalPrompt?: string;
  /**
   * Paths of the images that came with the request. Stored as addresses,
   * not bytes: a later turn retrieves the path and opens it with
   * view_image, so "what was on the screenshot?" is answered from the
   * picture rather than from an earlier description of it.
   */
  attachmentPaths?: string[];
  /** Final assistant answer, including recommendations the user may refer to. */
  assistantText?: string;
  changedFiles: string[];
  validation: ValidationResult[];
  planGoal: string;
  /** Plan steps, so each unit of work becomes its own retrievable chunk. */
  steps?: Array<{ title: string; files: string[]; status?: string }>;
  /** Verdict from the independent review stage, when it ran. */
  reviewVerdict?: "pass" | "fail" | null;
  /** Defaults to "completed"; cancel/error paths pass their own. */
  status?: TaskOutcomeStatus;
  /** Assistant text produced before an interruption, for partial recall. */
  partialText?: string;
}

/**
 * Builds the compressed record of a task from data the summary stage already
 * has — no LLM call. The overview line replaces the whole turn; the details
 * give RAG something finer than "this task happened" to match against.
 */
export function buildTaskSummary(input: BuildTaskSummaryInput): TaskSummary {
  const status = input.status ?? "completed";
  const failed = input.validation.filter((v) => !v.ok);
  const outcome =
    input.validation.length === 0
      ? null
      : failed.length === 0
        ? "validation green"
        : `validation failing: ${failed.map((v) => v.kind).join(", ")}`;

  const lines = [`request: ${input.intentSummary || input.planGoal}`];
  if (input.planGoal && input.planGoal !== input.intentSummary) {
    lines.push(`goal: ${input.planGoal}`);
  }
  if (input.changedFiles.length > 0) {
    lines.push(`changed: ${input.changedFiles.slice(0, 6).join(", ")}`);
  }
  if (outcome) lines.push(outcome);
  if (input.reviewVerdict) lines.push(`review ${input.reviewVerdict}`);
  // An interrupted task must SAY it was interrupted: the next turn (often on
  // another provider) has to know the work is unfinished, not just absent.
  if (status !== "completed") {
    lines.push(status === "cancelled" ? "INTERRUPTED by user" : "ENDED in error");
  }

  return {
    taskId: input.taskId,
    conversationId: input.conversationId,
    text: lines.join(" · ").slice(0, 600),
    changedFiles: input.changedFiles.slice(0, 20),
    outcome,
    status,
    details: buildDetails(input),
    createdAt: Date.now(),
  };
}

/**
 * The retrievable units of the task. Plan steps are the natural seam — each
 * is one intent with its own files — and the changed files that no step
 * claimed still deserve a row so a later "what did you do to X?" can hit.
 */
function buildDetails(input: BuildTaskSummaryInput): SessionDetail[] {
  const details: SessionDetail[] = [];
  const claimed = new Set<string>();

  const originalPrompt = clipSessionBody(input.originalPrompt);
  const attached = input.attachmentPaths ?? [];
  if (originalPrompt || attached.length > 0) {
    // The attachment lines sit INSIDE the request detail rather than in a
    // chunk of their own: a follow-up asks about "the image" in the same
    // breath as the request it came with, and one chunk keeps the words
    // and the picture's address on the same retrieval hit.
    const body = [
      originalPrompt,
      attached.length > 0
        ? `Images attached to this request (open with view_image):\n` +
          attached.map((p) => `- ${p}`).join("\n")
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    details.push({
      title:
        attached.length > 0
          ? "Original user request, with attached image(s)"
          : "Original user request",
      files: [],
      body,
    });
  }

  const assistantText = clipSessionBody(input.assistantText);
  if (assistantText) {
    details.push({
      title: "Assistant response",
      files: [],
      body: assistantText,
    });
  }

  for (const step of input.steps ?? []) {
    const title = step.title?.trim();
    if (!title) continue;
    // A plan is not an execution log. Only completed steps are durable facts;
    // status-less steps remain supported for older callers and stored records.
    if (step.status && step.status !== "done") continue;
    const files = step.files.filter(Boolean);
    for (const file of files) claimed.add(file);
    details.push({
      title: title.slice(0, 200),
      files: files.slice(0, 8),
    });
  }

  const unclaimed = input.changedFiles.filter((f) => !claimed.has(f));
  if (unclaimed.length > 0) {
    details.push({
      title: "other files changed in this task",
      files: unclaimed.slice(0, 12),
    });
  }

  // Partial work from an interrupted task: the tail of what the model said is
  // the only record of where it got to.
  if (input.status && input.status !== "completed" && input.partialText) {
    const tail = input.partialText.trim().slice(-600);
    if (tail) {
      details.push({
        title: "work in progress when the task was interrupted",
        files: [],
        body: tail,
      });
    }
  }

  return details.slice(0, 12);
}

/** Preserve the requested subject and the answer's conclusion under a cap. */
function clipSessionBody(value: string | undefined): string {
  const text = value?.trim() ?? "";
  const maxChars = 1_600;
  if (text.length <= maxChars) return text;
  const marker = "\n… [middle omitted] …\n";
  const available = maxChars - marker.length;
  const head = Math.floor(available * 0.4);
  return `${text.slice(0, head)}${marker}${text.slice(-(available - head))}`;
}
