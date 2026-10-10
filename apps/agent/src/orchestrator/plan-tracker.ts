import type { Plan, PlanStep, PlanStepStatus } from "@atelier/protocol";
import { newId } from "@atelier/shared";
import type { EventBus } from "../events/event-bus.js";
import type {
  LastPlanCheckpoint,
  PlanCheckpointStore,
} from "./plan-checkpoint-store.js";
import {
  extractDeliverables,
  uncoveredDeliverables,
} from "./request-deliverables.js";

/** A step as the model states it, before ids exist. */
export interface DraftStep {
  title: string;
  detail?: string;
  files?: string[];
}

export interface PlanStepTransition {
  ok: boolean;
  error?: string;
  /**
   * The live timeline, attached to EVERY failure.
   *
   * A refusal that only says "Unknown step id for this task" is a dead end:
   * the ids were minted at set_plan and handed back once, dozens of tool
   * calls ago, and a model that has lost them cannot guess its way back.
   * It retries, guesses again, re-sends set_plan (which APPENDS), and the
   * task grows steps it never planned while the call count runs away. So
   * every failure now carries the answer to the question the failure
   * raises: these are the steps, this is the one you are on.
   */
  steps?: Array<{ id: string; title: string; status: PlanStepStatus }>;
  /** Id of the step the timeline is actually waiting on, when there is one. */
  currentStepId?: string;
}

/** Consecutive failed transitions before the error stops being polite. */
const FAILED_TRANSITION_LIMIT = 3;

/** Steps past this are a task that should have been split, not a checklist. */
const MAX_STEPS = 12;

/** Appended to a done-note when nothing observed backed the checkmark. */
export const UNVERIFIED_MARK = "[unverified — model-asserted]";

/**
 * A step the timeline is no longer waiting on.
 *
 * `done` is the checkmark. `skipped` is the honest exit for a step that
 * turned out to target the wrong file or text: it is not progress, it
 * must not clear an implementation gate on its own, but it must also not
 * hold the timeline forever — the alternative was a model forced to fake a
 * checkmark on work it knew was wrong just to move on. `failed` and
 * `cancelled` stay live: they are stops, not decisions.
 */
export function isSettledStep(step: PlanStep): boolean {
  return step.status === "done" || step.status === "skipped";
}

/**
 * A step the timeline has moved past, whatever the outcome. Ordering asks
 * this, not isSettledStep: a step closed as cancelled or failed (which only
 * an in-progress step can be, with the reason on record) is behind the
 * model, and the next step is the one it is on. Treating it as still open
 * used to wedge the whole plan — every later transition was refused with
 * "finish the current step first", naming the step the model had just
 * cancelled, and nothing could ever be checked again. The completion gate
 * still lists it (unfinishedSteps), because it was not delivered.
 */
export function isClosedStep(step: PlanStep): boolean {
  return (
    isSettledStep(step) ||
    step.status === "cancelled" ||
    step.status === "failed"
  );
}

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
  /**
   * Turns whose deliverable is the plan itself — Plan mode, an answer-only
   * turn, or a request that asks to study and plan without implementing.
   * Their steps are study and design steps: checking one off over an
   * untouched workspace is the correct outcome, not the claim the edit
   * gate exists to refuse, and the request's bullet points are the spec
   * being planned, not deliverables the plan must build.
   */
  private planOnly = new Set<string>();
  /** Step ids that received a real edit.applied event in this task. */
  private editedSteps = new Map<string, Set<string>>();
  /** Consecutive rejected transitions per task; reset by any that lands. */
  private failedTransitions = new Map<string, number>();
  /**
   * Task → conversation, so a tool that only holds a task id (set_plan)
   * can still ask what the previous turn of the same conversation planned.
   */
  private conversations = new Map<string, string>();
  /**
   * Task → the separately deliverable items its request listed. Read at
   * set_plan: a plan that names none of an item's words is asked to
   * either add a step for it or declare it not covered. See
   * request-deliverables.ts for the turn this exists because of.
   */
  private deliverables = new Map<string, string[]>();

  constructor(
    private bus: EventBus,
    private checkpoints?: PlanCheckpointStore
  ) {}

  bindTask(conversationId: string, taskId: string, request: string): void {
    this.conversations.set(taskId, conversationId);
    this.deliverables.set(taskId, extractDeliverables(request));
    this.checkpoints?.bind(conversationId, taskId, request);
  }

  /** The request's listed items, as bindTask extracted them. */
  deliverablesOf(taskId: string): string[] {
    return this.deliverables.get(taskId) ?? [];
  }

  /**
   * Requested items that neither the drafted plan nor the model's own
   * not-covered declaration mentions. Empty for a request that listed
   * nothing, and for an answer-only turn, which owes no plan.
   */
  coverageGaps(
    taskId: string,
    goal: string,
    drafts: DraftStep[],
    notCovered: string[] = []
  ): string[] {
    if (this.answerOnly.has(taskId) || this.planOnly.has(taskId)) return [];
    const items = this.deliverablesOf(taskId);
    if (items.length === 0) return [];
    const planText = [
      goal,
      ...drafts.map((draft) =>
        [draft.title, draft.detail ?? "", ...(draft.files ?? [])].join(" ")
      ),
      ...notCovered,
    ].join("\n");
    return uncoveredDeliverables(items, planText);
  }

  /** What the active plan declared it would not deliver. */
  notCoveredFor(taskId: string): string[] {
    return this.plans.get(taskId)?.notCovered ?? [];
  }

  resumeContext(conversationId: string, previousTaskId: string): string {
    return this.checkpoints?.resumeContext(conversationId, previousTaskId) ?? "";
  }

  /**
   * The newest checkpointed plan of the conversation other than the task
   * asking. Null without a checkpoint store or a previous plan.
   */
  previousPlan(
    conversationId: string,
    excludeTaskId?: string
  ): LastPlanCheckpoint | null {
    return this.checkpoints?.lastCheckpoint(conversationId, excludeTaskId) ?? null;
  }

  /** previousPlan for the conversation a task was bound to, if any. */
  previousPlanFor(taskId: string): LastPlanCheckpoint | null {
    const conversationId = this.conversations.get(taskId);
    if (!conversationId) return null;
    return this.previousPlan(conversationId, taskId);
  }

  removeConversation(conversationId: string): void {
    for (const [taskId, bound] of this.conversations) {
      if (bound === conversationId) this.conversations.delete(taskId);
    }
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

  /** Marks a turn that owes a plan, not a change; see `planOnly`. */
  markPlanOnly(taskId: string): void {
    this.planOnly.add(taskId);
  }

  isPlanOnly(taskId: string): boolean {
    return this.planOnly.has(taskId);
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
  adopt(
    taskId: string,
    goal: string,
    drafts: DraftStep[],
    notCovered: string[] = []
  ): Plan {
    const steps = mintSteps(drafts.slice(0, MAX_STEPS));
    const plan: Plan = {
      id: newId("plan"),
      taskId,
      goal,
      steps,
      ...(notCovered.length > 0 ? { notCovered } : {}),
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
    this.publishStep(plan, step);
    return true;
  }

  /**
   * Records observed proof against the step being worked on: a test or
   * typecheck command that exited 0, a validation pass. The pipeline calls
   * this; the model cannot. That asymmetry is the point — "done" is the
   * model's word, `verification` is something that happened, and the UI
   * draws the checkmark solid only for the second.
   */
  noteVerified(taskId: string, summary: string): boolean {
    const plan = this.plans.get(taskId);
    if (!plan) return false;
    const step = plan.steps.find((candidate) => candidate.status === "in-progress");
    const text = summary.trim();
    if (!step || !text) return false;
    step.verification = text;
    this.checkpoints?.save(plan);
    this.publishStep(plan, step);
    return true;
  }

  /**
   * Model-facing transition guard. A timeline is executed in order, and a
   * checkmark is explicit: pending cannot jump straight to done, and later
   * steps cannot start while an earlier step is anything other than done
   * or skipped-with-a-reason.
   */
  transitionStep(
    taskId: string,
    stepId: string,
    status: PlanStepStatus,
    note?: string
  ): PlanStepTransition {
    const plan = this.plans.get(taskId);
    if (!plan) {
      return this.reject(
        taskId,
        undefined,
        "No active plan for this task. Call set_plan first; it returns the " +
          "step ids update_plan_step needs."
      );
    }
    const index = resolveStepIndex(plan, stepId);
    if (index < 0) {
      const current = plan.steps.find((step) => !isClosedStep(step));
      return this.reject(
        taskId,
        plan,
        `No step matches "${String(stepId ?? "").trim() || "(no id given)"}". ` +
          "Use one of the ids below, or its exact title, or omit stepId " +
          "entirely to mean the step the timeline is waiting on" +
          (current ? ` — that is "${current.title}".` : ".")
      );
    }
    const step = plan.steps[index]!;
    if (status === step.status && isClosedStep(step)) {
      return this.accept(taskId);
    }

    const current = plan.steps.findIndex((candidate) => !isClosedStep(candidate));
    if (index !== current) {
      const title = current >= 0 ? plan.steps[current]!.title : "the completed plan";
      return this.reject(
        taskId,
        plan,
        `Timeline order is enforced; finish the current step first: ${title}.`
      );
    }
    if (status === "done" && step.status !== "in-progress") {
      return this.reject(
        taskId,
        plan,
        "Start this step with in-progress before checking it done."
      );
    }
    const edited = this.editedSteps.get(taskId);
    const planOnly = this.planOnly.has(taskId);
    if (
      status === "done" &&
      !planOnly &&
      !edited?.has(step.id) &&
      stepNeedsEdit(step, (edited?.size ?? 0) > 0)
    ) {
      return this.reject(
        taskId,
        plan,
        "This step has 0 applied edits, and nothing in this task has been " +
          "changed yet. Apply the edit this step describes before checking " +
          "it done — a checkmark over an unchanged workspace is the one " +
          "thing the timeline must never show."
      );
    }
    // A step may be skipped before it starts, but only with the reason on
    // record: "skipped" with no note is indistinguishable from "forgot".
    if (status === "skipped" && step.status === "pending") {
      if (!note?.trim()) {
        return this.reject(
          taskId,
          plan,
          "Skipping a step that never started needs a note saying why " +
            "(for example: targets the wrong file). Send the same call " +
            "with a note."
        );
      }
    } else if (
      (status === "failed" || status === "cancelled" || status === "skipped") &&
      step.status !== "in-progress"
    ) {
      return this.reject(
        taskId,
        plan,
        `Start this step before marking it ${status}; only done clears ` +
          "the completion gate."
      );
    }
    // step.id, never the caller's reference: a title or an omitted
    // id resolved to this step, and the event must carry the real one.
    const finalNote = planOnly ? note?.trim() || undefined : doneNote(step, status, note);
    this.updateStep(taskId, step.id, status, finalNote);
    return this.accept(taskId);
  }

  /** A transition landed; the task is making progress again. */
  private accept(taskId: string): PlanStepTransition {
    this.failedTransitions.delete(taskId);
    return { ok: true };
  }

  /**
   * A refusal the model can act on: the reason, the exact call that would
   * be accepted next, the whole timeline, and which step it is actually on.
   *
   * After three consecutive rejections the wording changes. At that point
   * the model is not misreading the reason, it is looping on it — that is
   * the shape the user saw, sixty-one tool calls against one step — so the
   * error stops explaining the rule and starts naming the way out. One of
   * those ways out is admitting the step itself is wrong: a loop against a
   * step that targets the wrong file only ends by skipping it.
   */
  private reject(
    taskId: string,
    plan: Plan | undefined,
    error: string
  ): PlanStepTransition {
    const failures = (this.failedTransitions.get(taskId) ?? 0) + 1;
    this.failedTransitions.set(taskId, failures);
    const steps = plan?.steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
    }));
    const current = plan?.steps.find((step) => !isClosedStep(step));
    const next = current ? ` Exact next call: ${nextCall(current)}.` : "";
    const looping =
      failures >= FAILED_TRANSITION_LIMIT
        ? ` This is update_plan_step failure ${failures} in a row. STOP ` +
          "retrying it and stop calling set_plan — set_plan APPENDS to a " +
          "plan that already exists and will only add steps you did not " +
          "plan. " +
          (current
            ? `Do the work described by "${current.title}", then send ` +
              `exactly: update_plan_step(stepId: "${current.id}", status: ` +
              '"in-progress") followed by the same call with status "done". ' +
              "If the current step targets the wrong file or text, mark it " +
              "skipped with a note saying why — " +
              `update_plan_step(stepId: "${current.id}", status: "skipped", ` +
              'note: "<why>") — then set_plan the correct step; that is the ' +
              "one case where appending is right. "
            : "") +
          "If the step cannot be done, end your reply with a line starting " +
          "`BLOCKED:` naming what the user must resolve."
        : "";
    return {
      ok: false,
      error: error + next + looping,
      ...(steps ? { steps } : {}),
      ...(current ? { currentStepId: current.id } : {}),
    };
  }

  /**
   * A real edit may start the current step, but it never manufactures a
   * checkmark and never advances past an earlier unfinished timeline item.
   */
  noteFileEdited(taskId: string, relPath: string): void {
    const plan = this.plans.get(taskId);
    if (!plan) return;
    const index = plan.steps.findIndex((step) => !isClosedStep(step));
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

  /**
   * Records effect that left no file diff.
   *
   * `editedSteps` was fed only by `edit.applied`, which made "did this step
   * do anything?" mean "did it write to a file?". A great deal of real work
   * does not: `git reset --hard`, `git branch`, `git fetch`, a migration
   * run, a container rebuilt. A turn that cleaned a branch back to its
   * remote changed the repository decisively, produced zero applied edits,
   * and could then never check a step off — so the gate stayed open, the
   * turn reported BLOCKED, and the user was told Atelier "cannot mark
   * Git-ref-only operations complete". The work was done; only the
   * bookkeeping said otherwise.
   *
   * A command that ran to a clean exit inside a started step is effect, and
   * counts the same as an edit would. The looser end of this is a step
   * checked off behind a successful `ls` — accepted deliberately: order is
   * still enforced, the step must already be in-progress, and the gate
   * still holds the whole plan. An unclosable timeline is the worse fault.
   */
  noteWorkObserved(taskId: string): void {
    const plan = this.plans.get(taskId);
    if (!plan) return;
    const step = plan.steps.find((candidate) => !isSettledStep(candidate));
    if (!step || step.status !== "in-progress") return;
    const edited = this.editedSteps.get(taskId) ?? new Set<string>();
    edited.add(step.id);
    this.editedSteps.set(taskId, edited);
  }

  /**
   * Every state except an explicit checkmark or a reasoned skip remains
   * live work — the completion gate reads this.
   */
  unfinishedSteps(taskId: string): PlanStep[] {
    return this.plans.get(taskId)?.steps.filter((step) => !isSettledStep(step)) ?? [];
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
    this.planOnly.delete(taskId);
    this.editedSteps.delete(taskId);
    this.failedTransitions.delete(taskId);
    this.conversations.delete(taskId);
    this.deliverables.delete(taskId);
    this.checkpoints?.release(taskId);
  }

  /**
   * Every step event carries the step's whole record (note + verification),
   * not only the field that changed: the UI replaces its row from the
   * payload, and a verification event that dropped the note would blank it.
   */
  private publishStep(plan: Plan, step: PlanStep): void {
    this.bus.publish(
      "plan.step.updated",
      {
        planId: plan.id,
        stepId: step.id,
        status: step.status,
        ...(step.note ? { note: step.note } : {}),
        ...(step.verification ? { verification: step.verification } : {}),
      },
      plan.taskId
    );
  }
}

/**
 * The one update_plan_step call the timeline would accept next: start the
 * current step, or finish it if it is already running. Spelled out in full
 * because a refusal that names the rule but not the call is what the model
 * was looping on.
 */
function nextCall(step: PlanStep): string {
  const status = step.status === "in-progress" ? "done" : "in-progress";
  return `update_plan_step(stepId: "${step.id}", status: "${status}")`;
}

/**
 * The note a done-transition records. A checkmark on an implementation
 * step that nothing observed (no test, typecheck or validation pass landed
 * on it) is the model's own word, and the record says so — "done" used to
 * read the same whether it had been checked or merely declared.
 */
function doneNote(
  step: PlanStep,
  status: PlanStepStatus,
  note: string | undefined
): string | undefined {
  const text = note?.trim();
  if (status !== "done" || step.verification) return text || undefined;
  // Only the change verb matters here, not the NON_EDIT exemption the
  // edit gate uses: "Verify the fix" closed with nothing observed is the
  // exact claim this mark exists to flag.
  if (!IMPLEMENTATION_STEP.test(step.title)) return text || undefined;
  if (text?.includes(UNVERIFIED_MARK)) return text;
  return text ? `${text} ${UNVERIFIED_MARK}` : UNVERIFIED_MARK;
}

/**
 * Finds the step a model MEANT, not just the one whose id it quoted.
 *
 * Ids are minted at set_plan and returned once. By the time the twentieth
 * tool call of a step wants to check it off, that result is far behind in
 * the transcript, and the model reaches for what it can still see: the
 * step's title, or nothing at all. Both used to land on "Unknown step id
 * for this task", which is a dead end rather than a correction.
 *
 * So three references resolve, in descending order of certainty: the id,
 * the title (which the tracker already treats as a step's visible identity
 * — see draftKey), and an omitted reference, which can only mean the step
 * the timeline is waiting on. A reference that is present but matches
 * nothing still fails: order is enforced below, so silently redirecting a
 * wrong id to the current step could check off a step the model never
 * named, and a listed refusal is the safer answer.
 */
function resolveStepIndex(plan: Plan, stepId: string): number {
  const ref = typeof stepId === "string" ? stepId.trim() : "";
  if (!ref) return plan.steps.findIndex((step) => !isClosedStep(step));
  const byId = plan.steps.findIndex((step) => step.id === ref);
  if (byId >= 0) return byId;
  const wanted = ref.toLowerCase();
  return plan.steps.findIndex((step) => step.title.trim().toLowerCase() === wanted);
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

/**
 * The title is the visible step identity. Providers may repeat set_plan
 * with richer or missing file metadata; that must update neither the
 * execution contract nor the checklist with a duplicate-looking row. The
 * same key says whether a new plan repeats a step of a previous one.
 */
export function draftKey(draft: DraftStep): string {
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
