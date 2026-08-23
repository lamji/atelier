import type { EventBus } from "../events/event-bus.js";
import type { PlanTracker } from "../orchestrator/plan-tracker.js";
import type { HookDecision, HookGuardContext } from "./hooks-engine.js";

export const ANSWER_ONLY_HOOK_ID = "builtin-answer-only";
export const ANSWER_ONLY_HOOK_NAME = "Question turns do not edit";

const EDIT_TOOLS = new Set(["write_file", "replace_code", "replace_many"]);

/**
 * Stops a turn the user asked as a QUESTION from editing the workspace.
 *
 * The pipeline already classifies intent and, on a question, ships
 * ANSWER_ONLY_RULES telling the model to reply in prose and change
 * nothing. That is a rule in the prompt — advice — and a model that
 * decides the answer would be better demonstrated than described edits
 * anyway. Users see it as the app doing work they never asked for, which
 * is the worst kind of surprise: unrequested writes to their code.
 *
 * Worse, a question turn is exactly where the plan-before-edit gate is
 * deliberately switched OFF (an answer owes no execution plan), so an
 * edit made here also skips the guard that would otherwise force a plan
 * first. Question turns were the least supervised turns in the app.
 *
 * This closes it at the tool layer, where it is a fact rather than a
 * rule: every provider — Claude through MCP, Ollama through its own loop
 * — reaches the workspace through ToolRegistry.run, so one guard covers
 * them all. Reading, searching, and running read-only checks stay open;
 * answering "why does this fail?" often needs them.
 */
export class AnswerOnlyGuard {
  constructor(
    private plans: PlanTracker,
    private bus: EventBus
  ) {}

  async check(ctx: HookGuardContext): Promise<HookDecision | undefined> {
    if (!EDIT_TOOLS.has(ctx.toolName)) return undefined;
    if (!this.plans.isAnswerOnly(ctx.taskId)) return undefined;

    const reason =
      "This turn is a question, so it may not edit files. Answer it in " +
      "prose: say what you would change, in which file, and why. If the " +
      "user wants it done they will ask, and that turn may edit.";
    this.bus.publish(
      "hook.blocked",
      { hookId: ANSWER_ONLY_HOOK_ID, name: ANSWER_ONLY_HOOK_NAME, reason },
      ctx.taskId
    );
    return { allowed: false, reason };
  }
}
