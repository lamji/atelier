import type { Plan, PlanStep, PlanStepStatus } from "@atelier/protocol";
import { newId } from "@atelier/shared";
import type { EventBus } from "../events/event-bus.js";

/** A step as the model states it, before ids exist. */
export interface DraftStep {
  title: string;
  detail?: string;
  files?: string[];
}

/** Steps past this are a task that should have been split, not a checklist. */
const MAX_STEPS = 12;

/**
 * Holds the active Plan per task and publishes step updates. The model
 * drives progress through the update_plan_step tool; the UI renders the
 * live checklist from plan.created + plan.step.updated events.
 */
export class PlanTracker {
  private plans = new Map<string, Plan>();

  constructor(private bus: EventBus) {}

  setPlan(plan: Plan): void {
    this.plans.set(plan.taskId, plan);
  }

  /**
   * Replaces the placeholder plan with the one the model actually committed
   * to, mints the step ids and announces it.
   *
   * The pipeline seeds a single-step plan before the model has read a line
   * of code, because the rail needs something at t=0 — but that placeholder
   * is all the UI ever had, which is why a plan never appeared. This is the
   * real one, and it costs no extra model call: the model calls `set_plan`
   * partway through the turn it was already having.
   *
   * Returns the minted steps so the tool result can hand the model the ids
   * it needs for `update_plan_step`.
   */
  adopt(taskId: string, goal: string, drafts: DraftStep[]): Plan {
    const steps: PlanStep[] = drafts.slice(0, MAX_STEPS).map((draft) => ({
      id: newId("step"),
      title: draft.title,
      ...(typeof draft.detail === "string" && draft.detail
        ? { detail: draft.detail }
        : {}),
      files: Array.isArray(draft.files) ? draft.files.map(String) : [],
      status: "pending" as const,
    }));
    const plan: Plan = {
      id: newId("plan"),
      taskId,
      goal,
      steps,
      createdAt: Date.now(),
    };
    this.plans.set(taskId, plan);
    this.bus.publish("plan.created", plan, taskId);
    return plan;
  }

  get(taskId: string): Plan | undefined {
    return this.plans.get(taskId);
  }

  updateStep(
    taskId: string,
    stepId: string,
    status: PlanStepStatus,
    note?: string
  ): boolean {
    const plan = this.plans.get(taskId);
    if (!plan) return false;
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) return false;
    step.status = status;
    if (note) step.note = note;
    this.bus.publish(
      "plan.step.updated",
      { planId: plan.id, stepId, status, note },
      taskId
    );
    return true;
  }

  /**
   * Advances the plan from a real edit, so progress shows even when the
   * model never calls update_plan_step. Monotonic: the step that owns the
   * edited file goes in-progress and every earlier unfinished step is
   * marked done. Never regresses a step the model already completed.
   */
  noteFileEdited(taskId: string, relPath: string): void {
    const plan = this.plans.get(taskId);
    if (!plan) return;
    const target = normPath(relPath);
    const owns = (step: (typeof plan.steps)[number]): boolean =>
      step.files.some((f) => pathsMatch(normPath(f), target));

    // Prefer the earliest not-yet-done step that owns the file.
    let idx = plan.steps.findIndex((s) => s.status !== "done" && owns(s));
    if (idx < 0) idx = plan.steps.findIndex(owns);
    if (idx < 0) return;

    for (let i = 0; i < idx; i++) {
      const s = plan.steps[i]!;
      if (s.status === "pending" || s.status === "in-progress") {
        this.updateStep(taskId, s.id, "done");
      }
    }
    if (plan.steps[idx]!.status === "pending") {
      this.updateStep(taskId, plan.steps[idx]!.id, "in-progress");
    }
  }

  /** Task finished cleanly: everything still open is marked done. */
  completeAll(taskId: string): void {
    const plan = this.plans.get(taskId);
    if (!plan) return;
    for (const step of plan.steps) {
      if (step.status === "pending" || step.status === "in-progress") {
        this.updateStep(taskId, step.id, "done");
      }
    }
  }

  /** Cancellation: everything not finished flips to cancelled. */
  cancelPending(taskId: string): void {
    const plan = this.plans.get(taskId);
    if (!plan) return;
    for (const step of plan.steps) {
      if (step.status === "pending" || step.status === "in-progress") {
        this.updateStep(taskId, step.id, "cancelled");
      }
    }
  }

  clear(taskId: string): void {
    this.plans.delete(taskId);
  }
}

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase().trim();
}

/** Exact match, or one path is the tail of the other (relative-root drift). */
function pathsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith("/" + b) || b.endsWith("/" + a);
}
