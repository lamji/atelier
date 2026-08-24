import type { Plan, PlanStep, PlanStepStatus } from "@atelier/protocol";
import { newId } from "@atelier/shared";
import type { EventBus } from "../events/event-bus.js";
import type { PlanCheckpointStore } from "./plan-checkpoint-store.js";

/** A step as the model states it, before ids exist. */
export interface DraftStep {
  title: string;
  detail?: string;
  files?: string[];
}

export interface PlanStepTransition {
  ok: boolean;
  error?: string;
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
  private planRequired = new Set<string>();
  /**
   * Tasks the user asked as a QUESTION. Kept here beside planRequired
   * because both answer the same shape of question — what is this turn
   * allowed to do — and both are read by preTool guards that get nothing
   * but a task id.
   */
  private answerOnly = new Set<string>();
  /** Step ids that received a real edit.applied event in this task. */
  private editedSteps = new Map<string, Set<string>>();

  constructor(
    private bus: EventBus,
    private checkpoints?: PlanCheckpointStore
  ) {}

  bindTask(conversationId: string, taskId: string, request: string): void {
    this.checkpoints?.bind(conversationId, taskId, request);
  }

  resumeContext(conversationId: string, previousTaskId: string): string {
    return this.checkpoints?.resumeContext(conversationId, previousTaskId) ?? "";
  }

  removeConversation(conversationId: string): void {
    this.checkpoints?.removeConversation(conversationId);
  }

  setPlan(plan: Plan): void {
    this.plans.set(plan.taskId, plan);
    this.editedSteps.delete(plan.taskId);
    this.checkpoints?.save(plan);
  }

  /** Marks a pipeline task whose workspace edits must belong to a live step. */
  requirePlan(taskId: string): void {
    this.planRequired.add(taskId);
  }

  requiresPlan(taskId: string): boolean {
    return this.planRequired.has(taskId);
  }

  /**
   * Marks a turn that owes the user an ANSWER, not a change. The
   * answer-only guard refuses this task's edit tools; see
   * hooks/answer-only-guard.ts for why a prompt rule was not enough.
   */
  markAnswerOnly(taskId: string): void {
    this.answerOnly.add(taskId);
  }

  isAnswerOnly(taskId: string): boolean {
    return this.answerOnly.has(taskId);
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
    const steps = mintSteps(drafts.slice(0, MAX_STEPS));
    const plan: Plan = {
      id: newId("plan"),
      taskId,
      goal,
      steps,
      createdAt: Date.now(),
    };
    this.plans.set(taskId, plan);
    this.editedSteps.delete(taskId);
    this.checkpoints?.save(plan);
    this.bus.publish("plan.created", plan, taskId);
    return plan;
  }

  /**
   * Appends newly discovered work without allowing a second set_plan call to
   * erase, reorder, or silently complete the execution contract already shown
   * to the user. Re-publishing the full Plan lets every UI consumer replace
   * its snapshot atomically while preserving the existing step ids/statuses.
   */
  extend(taskId: string, drafts: DraftStep[]): PlanStep[] {
    const plan = this.plans.get(taskId);
    if (!plan) return [];
    const existing = new Set(plan.steps.map(stepKey));
    const unique: DraftStep[] = [];
    for (const draft of drafts) {
      const key = draftKey(draft);
      if (existing.has(key)) continue;
      existing.add(key);
      unique.push(draft);
    }
    const appended = mintSteps(
      unique.slice(0, Math.max(0, MAX_STEPS - plan.steps.length))
    );
    if (appended.length === 0) return [];
    plan.steps.push(...appended);
    this.checkpoints?.save(plan);
    this.bus.publish("plan.created", plan, taskId);
    return appended;
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
    this.checkpoints?.save(plan);
    this.bus.publish(
      "plan.step.updated",
      { planId: plan.id, stepId, status, note },
      taskId
    );
    return true;
  }

  /**
   * Model-facing transition guard. A timeline is executed in order, and a
   * checkmark is explicit: pending cannot jump straight to done, and later
   * steps cannot start while an earlier step is anything other than done.
   */
  transitionStep(
    taskId: string,
    stepId: string,
    status: PlanStepStatus,
    note?: string
  ): PlanStepTransition {
    const plan = this.plans.get(taskId);
    if (!plan) return { ok: false, error: "No active plan for this task" };
    const index = plan.steps.findIndex((step) => step.id === stepId);
    if (index < 0) {
      return { ok: false, error: "Unknown step id for this task" };
    }
    const step = plan.steps[index]!;
    if (status === "done" && step.status === "done") return { ok: true };

    const current = plan.steps.findIndex((candidate) => candidate.status !== "done");
    if (index !== current) {
      const title = current >= 0 ? plan.steps[current]!.title : "the completed plan";
      return {
        ok: false,
        error: `Timeline order is enforced; finish the current step first: ${title}`,
      };
    }
    if (status === "done" && step.status !== "in-progress") {
      return {
        ok: false,
        error: "Start this step with in-progress before checking it done",
      };
    }
    const edited = this.editedSteps.get(taskId);
    if (
      status === "done" &&
      !edited?.has(step.id) &&
      stepNeedsEdit(step, (edited?.size ?? 0) > 0)
    ) {
      return {
        ok: false,
        error:
          "This step has 0 applied edits, and nothing in this task has been " +
          "changed yet. Apply the edit this step describes before checking " +
          "it done — a checkmark over an unchanged workspace is the one " +
          "thing the timeline must never show.",
      };
    }
    if (
      (status === "failed" || status === "cancelled" || status === "skipped") &&
      step.status !== "in-progress"
    ) {
      return {
        ok: false,
        error: `Start this step before marking it ${status}; only done clears the completion gate`,
      };
    }
    this.updateStep(taskId, stepId, status, note);
    return { ok: true };
  }

  /**
   * A real edit may start the current step, but it never manufactures a
   * checkmark and never advances past an earlier unfinished timeline item.
   */
  noteFileEdited(taskId: string, relPath: string): void {
    const plan = this.plans.get(taskId);
    if (!plan) return;
    const index = plan.steps.findIndex((step) => step.status !== "done");
    if (index < 0) return;
    const step = plan.steps[index]!;
    const target = normPath(relPath);
    const owns = step.files.some((file) => pathsMatch(normPath(file), target));
    if (owns && step.status !== "in-progress") {
      this.updateStep(taskId, step.id, "in-progress");
    }
    // The plan-edit hook already guarantees that pipeline mutations belong
    // to the active step. Count the emitted edit even when the model's file
    // metadata was incomplete, otherwise a real patch can deadlock on a
    // guessed path list.
    if (step.status === "in-progress") {
      const edited = this.editedSteps.get(taskId) ?? new Set<string>();
      edited.add(step.id);
      this.editedSteps.set(taskId, edited);
    }
  }

  /** Every state except an explicit checkmark remains live work. */
  unfinishedSteps(taskId: string): PlanStep[] {
    return this.plans.get(taskId)?.steps.filter((step) => step.status !== "done") ?? [];
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
    this.planRequired.delete(taskId);
    this.answerOnly.delete(taskId);
    this.editedSteps.delete(taskId);
    this.checkpoints?.release(taskId);
  }
}

function mintSteps(drafts: DraftStep[]): PlanStep[] {
  return drafts.map((draft) => ({
    id: newId("step"),
    title: draft.title.trim(),
    ...(typeof draft.detail === "string" && draft.detail.trim()
      ? { detail: draft.detail.trim() }
      : {}),
    files: Array.isArray(draft.files) ? draft.files.map(String) : [],
    status: "pending" as const,
  }));
}

function draftKey(draft: DraftStep): string {
  // The title is the visible step identity. Providers may repeat set_plan
  // with richer or missing file metadata; that must update neither the
  // execution contract nor the checklist with a duplicate-looking row.
  return draft.title.trim().toLowerCase();
}

function stepKey(step: PlanStep): string {
  return draftKey(step);
}

const IMPLEMENTATION_STEP =
  /\b(?:fix|add|implement|refactor|build|create|update|remove|delete|change|rename|move|center|align|style|design|redesign|rebuild|make|put|set|use|replace|adjust|convert|wire|initialize|init|scaffold|setup|configure|define|declare|generate|write|extract|migrate|integrate|apply|enable|support|hook|connect)\b/i;

/**
 * Steps whose completion is evidenced by looking or running, not by
 * changing a file. Everything else is treated as work.
 */
const NON_EDIT_STEP =
  /\b(?:read|review|inspect|investigate|analyse|analyze|audit|check|verify|validate|test|typecheck|lint|run|search|find|locate|explore|confirm|measure|profile|compare|plan|decide|plan)\b/i;

/**
 * Why a green checkmark may be refused on a step with no applied edit.
 *
 * The old rule needed BOTH a change verb in the title and a non-empty
 * `files` array — and the model supplies both. Ollama shipped a plan whose
 * drafts carried no files at all and checked four steps done having changed
 * nothing; the guard never even ran. Anything the model can opt out of by
 * how it words a draft is not a guard.
 *
 * So the file list is no longer part of it, and there are two rules:
 *
 * - A step that names a change ("Implement base components") always owes an
 *   edit of its own. Nothing else evidences it.
 * - Any other step owes one only while the WHOLE TASK has landed zero
 *   edits. That is the state this exists for — a timeline going green over
 *   an untouched workspace — and it leaves a genuine "decide the theme"
 *   step free to close on a turn that is otherwise really working.
 *
 * Read/verify steps are exempt from both: running the check IS their work.
 */
function stepNeedsEdit(step: PlanStep, taskHasEdits: boolean): boolean {
  if (NON_EDIT_STEP.test(step.title)) return false;
  return IMPLEMENTATION_STEP.test(step.title) || !taskHasEdits;
}

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase().trim();
}

/** Exact match, or one path is the tail of the other (relative-root drift). */
function pathsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith("/" + b) || b.endsWith("/" + a);
}
