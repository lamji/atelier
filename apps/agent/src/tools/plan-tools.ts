import type { PlanStepStatus } from "@atelier/protocol";
import type { ToolRegistry } from "./registry.js";
import type { PlanTracker } from "../orchestrator/plan-tracker.js";

interface UpdatePlanStepInput {
  stepId: string;
  status: PlanStepStatus;
  note?: string;
}

/** Lets the model report plan progress; the UI checklist follows live. */
export function registerPlanTools(
  registry: ToolRegistry,
  tracker: PlanTracker
): void {
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
