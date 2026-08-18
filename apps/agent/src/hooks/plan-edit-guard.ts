import type { EventBus } from "../events/event-bus.js";
import type { PlanTracker } from "../orchestrator/plan-tracker.js";
import type {
  HookDecision,
  HookGuardContext,
} from "./hooks-engine.js";

export const PLAN_EDIT_HOOK_ID = "builtin-plan-before-edit";
export const PLAN_EDIT_HOOK_NAME = "Active plan step before edit";

const EDIT_TOOLS = new Set(["write_file", "replace_code", "replace_many"]);

/**
 * Keeps file mutations inside the published execution flow.
 *
 * Read-only preparation may happen before the plan exists, but an edit is
 * accepted only while one of that task's plan steps is explicitly in progress.
 * This makes the step id available when the tool and diff events are emitted,
 * so edits cannot fall into the timeline's unassigned preparation bucket.
 */
export class PlanEditGuard {
  constructor(
    private plans: PlanTracker,
    private bus: EventBus
  ) {}

  async check(
    ctx: HookGuardContext
  ): Promise<HookDecision | undefined> {
    if (!EDIT_TOOLS.has(ctx.toolName)) return undefined;
    if (!this.plans.requiresPlan(ctx.taskId)) return undefined;

    const plan = this.plans.get(ctx.taskId);
    const active = plan?.steps.find((step) => step.status === "in-progress");
    if (active) return undefined;

    const next = plan?.steps.find((step) => step.status !== "done");
    const reason = !plan
      ? "Publish the ordered execution flow with set_plan before editing, then mark its first step in-progress."
      : next
        ? `Start the current plan step with update_plan_step before editing: ${next.title}`
        : "The published plan is complete. Append the newly discovered work with set_plan, then mark that step in-progress before editing.";

    this.bus.publish(
      "hook.blocked",
      {
        hookId: PLAN_EDIT_HOOK_ID,
        name: PLAN_EDIT_HOOK_NAME,
        reason,
      },
      ctx.taskId
    );
    return { allowed: false, reason };
  }
}
