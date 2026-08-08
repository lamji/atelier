import { newId } from "@atelier/shared";
import type { DbApprovalOutcome, HookConfig } from "@atelier/protocol";
import type { EventBus } from "../events/event-bus.js";
import type { HookDecision } from "./hooks-engine.js";
import { detectDbIntent } from "./db-intent.js";
import { detectPackageCommandIntent } from "./package-command-intent.js";

export const DB_APPROVAL_HOOK_ID = "builtin-db-approval";
export const DB_APPROVAL_HOOK_NAME = "Database: ask before running DB commands";
export const NPM_APPROVAL_HOOK_ID = "builtin-npm-approval";
export const NPM_APPROVAL_HOOK_NAME =
  "Package manager: ask before running npm commands";

/** How long a parked operation waits for an answer before auto-denying. */
const APPROVAL_TIMEOUT_MS = 120_000;

/** How many tasks' denial memories we keep before evicting the oldest. */
const DENIAL_MEMORY_TASKS = 50;

const DENIAL_REASON: Record<Exclude<DbApprovalOutcome, "approved">, string> = {
  denied: "The user denied it.",
  expired: "The user did not answer within 2 minutes, so it was refused.",
  cancelled: "The task was cancelled while waiting for approval.",
};

/**
 * Human-in-the-loop gate for database and npm-family work. When either
 * hook is enabled, the command is PARKED, not failed: its approval event
 * opens the modal and the tool call resumes only if the user chooses run.
 * No answer within the deadline (or a cancelled task) means refused.
 */
export class DbApprovalGuard {
  private pending = new Map<string, (outcome: DbApprovalOutcome) => void>();

  /**
   * Commands the user already refused, per task. A model that re-issues a
   * refused command would otherwise park the run for another two minutes
   * per attempt — the answer is already known, so refuse it on the spot and
   * let the turn carry on.
   */
  private refused = new Map<string, Set<string>>();

  constructor(private bus: EventBus) {}

  /** Drops a finished task's denial memory. Safe to call more than once. */
  forgetTask(taskId: string): void {
    this.refused.delete(taskId);
  }

  /** Called by the RPC handler; false when nothing was waiting on `id`. */
  resolve(id: string, approved: boolean): boolean {
    const settle = this.pending.get(id);
    if (!settle) return false;
    settle(approved ? "approved" : "denied");
    return true;
  }

  async check(ctx: {
    toolName: string;
    input: unknown;
    taskId: string;
    hook: HookConfig;
    signal?: AbortSignal;
  }): Promise<HookDecision | undefined> {
    const dbIntent = detectDbIntent(ctx.toolName, ctx.input);
    const npmIntent =
      ctx.hook.id === NPM_APPROVAL_HOOK_ID
        ? detectPackageCommandIntent(ctx.toolName, ctx.input)
        : null;
    if (!dbIntent && !npmIntent) return undefined;

    const isNpm = npmIntent !== null;
    const command = dbIntent?.command ?? npmIntent!.command;
    const operation = dbIntent?.operation ?? `${npmIntent!.manager} ${npmIntent!.operation}`;
    const detail =
      dbIntent?.detail ?? "a package-manager command that may take time or change files";
    const noun = isNpm ? "Package command" : "Database operation";

    // Already refused in this task — answer immediately, do not re-park.
    if (this.refused.get(ctx.taskId)?.has(commandKey(command))) {
      return this.block(
        ctx,
        `${noun} skipped: the user already refused \`${command}\` in this ` +
          "task, so it was not run again. Continue with the rest of the " +
          "work and report what stayed unverified."
      );
    }

    const id = newId(isNpm ? "npmapp" : "dbapp");
    this.bus.publish(
      "hook.matched",
      { hookId: ctx.hook.id, name: ctx.hook.name, on: ctx.toolName },
      ctx.taskId
    );
    const request = {
      id,
      kind: isNpm ? "npm" : "database",
      operation,
      detail,
      command,
      expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
    } as const;
    if (isNpm) {
      this.bus.publish("npm.approval.requested", request, ctx.taskId);
    } else {
      this.bus.publish("db.approval.requested", request, ctx.taskId);
    }

    const outcome = await this.awaitAnswer(id, ctx.signal);
    if (isNpm) {
      this.bus.publish("npm.approval.resolved", { id, outcome }, ctx.taskId);
    } else {
      this.bus.publish("db.approval.resolved", { id, outcome }, ctx.taskId);
    }

    if (outcome === "approved") {
      this.bus.publish(
        "hook.completed",
        {
          hookId: ctx.hook.id,
          name: ctx.hook.name,
          output: `Approved by the user: ${command}`,
        },
        ctx.taskId
      );
      return undefined;
    }

    // Remember the refusal so a retry is answered instantly. A cancelled
    // task is not a judgement on the command, so it is not remembered.
    if (outcome !== "cancelled") this.remember(ctx.taskId, command);

    return this.block(
      ctx,
      `${noun} not approved. ${DENIAL_REASON[outcome]} ` +
        `Attempted: ${command}. Do not retry it or work around it ` +
        "(no alternative client, script, or ORM call) — carry on with the " +
        "rest of the task, then say what you wanted to run and why."
    );
  }

  /** Publishes `hook.blocked` and returns the decision the registry throws on. */
  private block(
    ctx: { taskId: string; hook: HookConfig },
    reason: string
  ): HookDecision {
    this.bus.publish(
      "hook.blocked",
      { hookId: ctx.hook.id, name: ctx.hook.name, reason },
      ctx.taskId
    );
    return { allowed: false, reason };
  }

  private remember(taskId: string, command: string): void {
    const seen = this.refused.get(taskId) ?? new Set<string>();
    seen.add(commandKey(command));
    this.refused.set(taskId, seen);
    // Map insertion order is oldest-first: evict the stalest tasks so a long
    // session cannot grow this without bound.
    while (this.refused.size > DENIAL_MEMORY_TASKS) {
      const oldest = this.refused.keys().next().value;
      if (oldest === undefined) break;
      this.refused.delete(oldest);
    }
  }

  /** Parks the call until the user answers, the deadline, or a cancel. */
  private awaitAnswer(
    id: string,
    signal?: AbortSignal
  ): Promise<DbApprovalOutcome> {
    return new Promise<DbApprovalOutcome>((resolve) => {
      let done = false;
      const settle = (outcome: DbApprovalOutcome): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        resolve(outcome);
      };
      const onAbort = () => settle("cancelled");
      const timer = setTimeout(() => settle("expired"), APPROVAL_TIMEOUT_MS);

      this.pending.set(id, settle);
      if (signal?.aborted) settle("cancelled");
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** Whitespace- and case-insensitive identity for "the same command again". */
function commandKey(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLowerCase();
}
