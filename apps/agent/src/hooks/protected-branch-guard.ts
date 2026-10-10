import { globMatch } from "@atelier/shared";
import type { EventBus } from "../events/event-bus.js";
import type { HookDecision, HookGuardContext } from "./hooks-engine.js";
import { detectGitFlowIntent } from "./git-flow-intent.js";

export const PROTECTED_BRANCH_HOOK_ID = "builtin-protected-branch";
export const PROTECTED_BRANCH_HOOK_NAME = "Protected branches are read-only";

/**
 * Everything that can change a file, plus the two tools that can PUBLISH
 * one.
 *
 * Editing was never the whole risk. A commit on a protected branch is the
 * thing that is awkward to undo, and a push is the thing that cannot be
 * undone at all — so blocking the edit while leaving `git commit` reachable
 * through the git tool or a terminal command protected the easy half and
 * left the expensive half open.
 */
export const PROTECTED_BRANCH_MATCHER =
  "write_file|replace_code|replace_many|git|run_terminal";

const EDIT_TOOLS = new Set(["write_file", "replace_code", "replace_many"]);

/**
 * Refuses workspace edits while the checkout sits on a protected branch.
 *
 * The rule people actually want is "never let it write straight to main" —
 * and every existing safeguard was aimed elsewhere. The plan gate asks for
 * a plan, the answer-only guard asks what the turn is for, the git-flow
 * guard stops the agent COMMITTING; none of them cares which branch the
 * edits are landing on. An agent working an hour on a protected branch was
 * a perfectly ordinary Tuesday.
 *
 * It sits at the tool boundary rather than in a prompt for the reason
 * every guard here does: Claude reaches the workspace through MCP, Codex
 * through its own bridge, Ollama through its loop, and all three arrive at
 * ToolRegistry.run. One guard covers every provider, and it is a fact
 * rather than a rule the model can decide to reinterpret.
 *
 * The branch is read from the bus, not asked for per call. `git.state.
 * changed` already carries it and fires on every checkout — including one
 * made in an external terminal — so the guard costs nothing per edit and
 * cannot be defeated by switching branches behind the app's back.
 */
export class ProtectedBranchGuard {
  private branch: string | null = null;

  constructor(
    private bus: EventBus,
    /** Read live, so unprotecting a branch takes effect without a restart. */
    private patterns: () => string[],
    /** Fallback when no state event has arrived yet this process. */
    private readBranch: () => Promise<string | null>
  ) {
    this.bus.subscribe((event) => {
      if (event.topic !== "git.state.changed") return;
      const next = (event.payload as { branch?: unknown } | null)?.branch;
      if (typeof next === "string" && next) this.branch = next;
    });
  }

  async check(ctx: HookGuardContext): Promise<HookDecision | undefined> {
    // What this call would do to a protected branch, if anything. The git
    // flow detector already reads both spellings — the `git` tool's commit
    // action and a `git push` typed into run_terminal — so a terminal is
    // not a way around this.
    const flow = EDIT_TOOLS.has(ctx.toolName)
      ? null
      : detectGitFlowIntent(ctx.toolName, ctx.input);
    const act = EDIT_TOOLS.has(ctx.toolName)
      ? "change files on it"
      : flow?.operation === "commit"
        ? "commit to it"
        : flow?.operation === "push"
          ? "push to it"
          : null;
    if (!act) return undefined;

    const patterns = this.patterns().filter((p) => p.trim());
    if (patterns.length === 0) return undefined;

    // The snapshot is normally already here; the read is the cold-start
    // case, and a failure to answer must not block the edit — a guard that
    // cannot tell which branch this is has nothing to protect.
    if (!this.branch) {
      this.branch = await this.readBranch().catch(() => null);
    }
    const branch = this.branch;
    if (!branch) return undefined;

    const matched = matchingPattern(branch, patterns);
    if (!matched) return undefined;

    const reason =
      `"${branch}" is a protected branch, so this turn may not ${act} ` +
      `(matched the rule "${matched}").\n` +
      "Do NOT try to switch branches yourself and do not retry. Say what " +
      "you would change and in which file, and ask the user to either " +
      "create a working branch for it or remove the protection in the git " +
      "panel's Protected tab. If you have already made changes elsewhere " +
      "in this turn, report them and stop.";
    this.bus.publish(
      "hook.blocked",
      {
        hookId: PROTECTED_BRANCH_HOOK_ID,
        name: PROTECTED_BRANCH_HOOK_NAME,
        reason,
      },
      ctx.taskId
    );
    return { allowed: false, reason };
  }
}

/**
 * The rule a branch fell foul of, or null.
 *
 * Both spellings are honoured because both are what people type: an exact
 * name ("main"), and a glob for a family of them ("release/*"). Matching is
 * case-insensitive — git branch names are case-sensitive on Linux and not
 * on Windows or macOS, and a protection that lapses because someone typed
 * "Main" is not a protection.
 */
export function matchingPattern(
  branch: string,
  patterns: string[]
): string | null {
  const name = branch.trim().toLowerCase();
  for (const pattern of patterns) {
    const rule = pattern.trim().toLowerCase();
    if (!rule) continue;
    if (rule === name) return pattern;
    if (rule.includes("*") && globMatch(rule, name)) return pattern;
  }
  return null;
}
