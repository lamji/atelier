import { newId } from "@atelier/shared";
import type { DbApprovalOutcome, HookConfig } from "@atelier/protocol";
import type { EventBus } from "../events/event-bus.js";
import type { HookDecision } from "./hooks-engine.js";
import { detectDbIntent } from "./db-intent.js";

export const DB_APPROVAL_HOOK_ID = "builtin-db-approval";
export const DB_APPROVAL_HOOK_NAME = "Database: ask before running DB commands";

/** How long a parked operation waits for an answer before auto-denying. */
const APPROVAL_TIMEOUT_MS = 120_000;

const DENIAL_REASON: Record<Exclude<DbApprovalOutcome, "approved">, string> = {
  denied: "The user denied this database operation.",
  expired: "The user did not answer within 2 minutes, so it was refused.",
  cancelled: "The task was cancelled while waiting for approval.",
};

/**
 * Human-in-the-loop gate for database work. When the hook is enabled,
 * every DB command the agent tries — migrations, clients, dumps, raw
 * DDL/DML — is PARKED, not failed: db.approval.requested opens the
 * approval modal and the tool call resumes only if the user approves.
 * No answer within the deadline (or a cancelled task) means refused.
 */
export class DbApprovalGuard {
  private pending = new Map<string, (outcome: DbApprovalOutcome) => void>();

  constructor(private bus: EventBus) {}

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
    const intent = detectDbIntent(ctx.toolName, ctx.input);
    if (!intent) return undefined;

    const id = newId("dbapp");
    this.bus.publish(
      "hook.matched",
      { hookId: ctx.hook.id, name: ctx.hook.name, on: ctx.toolName },
      ctx.taskId
    );
    this.bus.publish(
      "db.approval.requested",
      {
        id,
        operation: intent.operation,
        detail: intent.detail,
        command: intent.command,
        expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
      },
      ctx.taskId
    );

    const outcome = await this.awaitAnswer(id, ctx.signal);
    this.bus.publish("db.approval.resolved", { id, outcome }, ctx.taskId);

    if (outcome === "approved") {
      this.bus.publish(
        "hook.completed",
        {
          hookId: ctx.hook.id,
          name: ctx.hook.name,
          output: `Approved by the user: ${intent.command}`,
        },
        ctx.taskId
      );
      return undefined;
    }

    const reason =
      `Database operation not approved. ${DENIAL_REASON[outcome]} ` +
      `Attempted: ${intent.command}. Do not retry it or work around it ` +
      "(no alternative client, script, or ORM call) — describe what you " +
      "wanted to run and why, and let the user decide.";
    this.bus.publish(
      "hook.blocked",
      { hookId: ctx.hook.id, name: ctx.hook.name, reason },
      ctx.taskId
    );
    return { allowed: false, reason };
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
