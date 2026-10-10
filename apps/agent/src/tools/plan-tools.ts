import type { PlanStepStatus } from "@atelier/protocol";
import type { ToolRegistry } from "./registry.js";
import {
  draftKey,
  type DraftStep,
  type PlanTracker,
} from "../orchestrator/plan-tracker.js";

interface UpdatePlanStepInput {
  /** Id or exact title. Absent means the step the timeline is waiting on. */
  stepId?: string;
  status: PlanStepStatus;
  note?: string;
}

interface SetPlanInput {
  goal: string;
  steps: DraftStep[];
  /** Requested items this plan deliberately will not deliver, with why. */
  notCovered?: string[];
}

/**
 * The refusal for a plan that silently drops part of the request.
 *
 * The turn this exists for planned three steps — rewrite a prompt string,
 * extend its test, run the checks — against a request that listed an
 * indexer, a watcher, an MCP retriever, gate hooks and an impact radius.
 * Every step was done, every check green, and the report described the
 * whole design as delivered. The plan is where the narrowing happened,
 * so the plan is where it has to be said out loud.
 */
function coverageRefusal(gaps: string[]): string {
  return (
    "The request lists work that no step of this plan delivers:\n" +
    gaps.map((item) => `- ${item}`).join("\n") +
    "\nAdd a step for each item you will build. For any item you will " +
    "deliberately NOT deliver this turn, list it in `notCovered` with the " +
    "reason (e.g. \"file watcher — needs a design decision on debounce\"); " +
    "it is shown to the user as not delivered. Do not narrow the request " +
    "silently, and do not describe undelivered items as done in the report."
  );
}

const VALID_STATUS = new Set<string>([
  "pending",
  "in-progress",
  "done",
  "failed",
  "cancelled",
  "skipped",
]);

/**
 * The step of a plan the user STOPPED that this plan is about to repeat.
 *
 * The lock-in this breaks: the user interrupts a turn editing the wrong
 * file, says "still wrong", and the next turn plans the very same step
 * with the very same target — the cancelled attempt's edits read as
 * progress. A plan that repeats a stopped step is not forbidden (the step
 * may have been right and only slow), but it is told so, before it starts.
 */
function repeatedStoppedStepWarning(
  tracker: PlanTracker,
  taskId: string,
  drafts: DraftStep[]
): string | undefined {
  const previous = tracker.previousPlanFor(taskId);
  if (!previous || previous.status !== "cancelled") return undefined;
  const stopped = new Set(previous.plan.steps.map((step) => draftKey(step)));
  const repeated = drafts.find((draft) => stopped.has(draftKey(draft)));
  if (!repeated) return undefined;
  return (
    `The previous task planned the same step "${repeated.title.trim()}" ` +
    "and the user stopped it — their new message says the result is " +
    "still wrong. Re-read the request and target the text/element they " +
    "named before starting it."
  );
}

/** Lets the model report plan progress; the UI checklist follows live. */
export function registerPlanTools(
  registry: ToolRegistry,
  tracker: PlanTracker
): void {
  registry.register("set_plan", async (input: SetPlanInput, ctx) => {
    // The registry runs UI-invoked calls through the same path as model
    // ones, so the shape is not guaranteed by the SDK schema here. A bad
    // plan should come back as a correctable error, not a thrown tool.
    const raw = Array.isArray(input?.steps) ? input.steps : [];
    const drafts = raw.filter(
      (step) => typeof step?.title === "string" && step.title.trim()
    );
    if (drafts.length === 0) {
      return { ok: false, error: "A plan needs at least one titled step" };
    }
    const goal = typeof input?.goal === "string" ? input.goal.trim() : "";
    const warning = repeatedStoppedStepWarning(tracker, ctx.taskId, drafts);
    const existing = tracker.get(ctx.taskId);
    if (existing) {
      // The whole plan comes back either way. A model that called set_plan
      // to re-read ids it had lost was adding steps to get them; now the
      // ids arrive without the plan growing being the only way to see them.
      const plan = () =>
        tracker.get(ctx.taskId)?.steps.map((step) => ({
          id: step.id,
          title: step.title,
          status: step.status,
        })) ?? [];
      const appended = tracker.extend(ctx.taskId, drafts);
      return appended.length > 0
        ? {
            ok: true,
            mode: "appended",
            note:
              "This task already had a plan, so these were APPENDED to it — " +
              "set_plan never replaces a plan. Every step is listed below.",
            appended: appended.map((step) => ({
              id: step.id,
              title: step.title,
            })),
            steps: plan(),
            ...(warning ? { warning } : {}),
          }
        : {
            ok: false,
            error:
              "Nothing was appended: every step you sent is already on the " +
              "plan, or the 12-step limit is reached. The current plan is " +
              "below — drive it with update_plan_step; do not call set_plan " +
              "again.",
            steps: plan(),
          };
    }
    const notCovered = (
      Array.isArray(input?.notCovered) ? input.notCovered : []
    ).filter((item): item is string => typeof item === "string" && !!item.trim());
    // Held to the request: a plan that names none of a listed item's
    // words must either take it on or say it is leaving it out.
    const gaps = tracker.coverageGaps(ctx.taskId, goal, drafts, notCovered);
    if (gaps.length > 0) {
      return { ok: false, error: coverageRefusal(gaps), uncovered: gaps };
    }
    const plan = tracker.adopt(ctx.taskId, goal || "Task", drafts, notCovered);
    // The ids go straight back, so the model can mark the first step
    // in-progress on its very next call instead of asking where they are.
    return {
      ok: true,
      mode: "created",
      steps: plan.steps.map((step) => ({ id: step.id, title: step.title })),
      ...(notCovered.length > 0
        ? {
            notCovered,
            note:
              "These requested items are recorded as NOT delivered by this " +
              "turn and will be shown to the user with your report.",
          }
        : {}),
      ...(warning ? { warning } : {}),
    };
  });

  registry.register(
    "update_plan_step",
    async (input: UpdatePlanStepInput, ctx) => {
      // Same reason set_plan validates its own shape: UI-invoked calls do
      // not go through the SDK schema, and a bad status must come back as
      // a correctable error rather than write undefined onto the step.
      if (!VALID_STATUS.has(input?.status as string)) {
        return {
          ok: false,
          error:
            `Unknown status "${String(input?.status)}". Use one of: ` +
            `${[...VALID_STATUS].join(", ")}.`,
        };
      }
      return tracker.transitionStep(
        ctx.taskId,
        input?.stepId ?? "",
        input.status,
        input?.note
      );
    }
  );
}
