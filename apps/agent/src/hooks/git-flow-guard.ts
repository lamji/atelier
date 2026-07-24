import type { GitFlowOperation, HookConfig } from "@atelier/protocol";
import type { EventBus } from "../events/event-bus.js";
import type { HookDecision } from "./hooks-engine.js";
import { detectGitFlowIntent } from "./git-flow-intent.js";

export const GIT_FLOW_HOOK_ID = "builtin-git-flow";
export const GIT_FLOW_HOOK_NAME = "Git flow: confirm commit / push / PR";

/** What the model is told when its own git flow attempt is refused. */
const STEP_LABEL: Record<GitFlowOperation, string> = {
  commit: "commit",
  push: "push",
  pr: "pull request",
};

const GUIDANCE =
  "Atelier never runs the git flow automatically. A confirmation modal " +
  "is now open in the app: the user reviews the message, picks the " +
  "branch, and drives commit → push → PR from there. Do NOT retry " +
  "`git commit`, `git push`, or `gh pr create` (including through " +
  "run_terminal). Finish your work, then tell the user the changes are " +
  "ready and to continue in the git flow modal.";

/**
 * Blocks the agent from performing the git flow on its own and asks the
 * user instead: every refused attempt publishes git.flow.requested, which
 * opens the commit → push → PR wizard in the UI with the attempted
 * command and message pre-filled.
 *
 * Read-only git (status, log, diff), staging and branch switching are not
 * touched — only the three steps that publish work: commit, push, PR.
 */
export class GitFlowGuard {
  constructor(private bus: EventBus) {}

  async check(ctx: {
    toolName: string;
    input: unknown;
    taskId: string;
    hook: HookConfig;
  }): Promise<HookDecision | undefined> {
    const intent = detectGitFlowIntent(ctx.toolName, ctx.input);
    if (!intent) return undefined;

    const reason =
      `The ${STEP_LABEL[intent.operation]} step needs the user's ` +
      `confirmation. Attempted: ${intent.command}. ${GUIDANCE}`;

    this.bus.publish(
      "hook.matched",
      { hookId: ctx.hook.id, name: ctx.hook.name, on: ctx.toolName },
      ctx.taskId
    );
    this.bus.publish(
      "git.flow.requested",
      {
        operation: intent.operation,
        command: intent.command,
        commitMessage: intent.commitMessage,
        reason,
      },
      ctx.taskId
    );
    this.bus.publish(
      "hook.blocked",
      { hookId: ctx.hook.id, name: ctx.hook.name, reason },
      ctx.taskId
    );
    return { allowed: false, reason };
  }
}
