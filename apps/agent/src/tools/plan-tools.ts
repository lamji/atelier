import type { PlanStepStatus } from "@atelier/protocol";
import type { ToolRegistry } from "./registry.js";
import type { DraftStep, PlanTracker } from "../orchestrator/plan-tracker.js";

interface UpdatePlanStepInput {
  stepId: string;
  status: PlanStepStatus;
  note?: string;
}

interface SetPlanInput {
  goal: string;
  steps: DraftStep[];
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
    const plan = tracker.adopt(ctx.taskId, goal || "Task", drafts);
    // The ids go straight back, so the model can mark the first step
    // in-progress on its very next call instead of asking where they are.
    return {
      ok: true,
      steps: plan.steps.map((step) => ({ id: step.id, title: step.title })),
    };
  });

  registry.register(
    "update_plan_step",
    async (input: UpdatePlanStepInput, ctx) => {
      const updated = tracker.updateStep(
        ctx.taskId,
        input.stepId,
        input.status,
        input.note
      );
      return updated
        ? { ok: true }
        : { ok: false, error: "Unknown step id for this task" };
    }
  );
}
