import fs from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import type { Plan } from "@atelier/protocol";

const CHECKPOINT_VERSION = 1;

interface TaskBinding {
  conversationId: string;
  taskId: string;
  request: string;
}

interface PlanCheckpoint extends TaskBinding {
  version: typeof CHECKPOINT_VERSION;
  updatedAt: number;
  plan: Plan;
}

/**
 * How a checkpointed plan ended. `cancelled` wins over everything else:
 * a plan the user stopped mid-way is the signal the next turn needs
 * ("you planned this before and were told to stop"), and it must not
 * read as unfinished-but-fine just because earlier steps were checked.
 */
export type PlanCheckpointStatus = "cancelled" | "complete" | "unfinished";

export interface LastPlanCheckpoint {
  taskId: string;
  request: string;
  plan: Plan;
  status: PlanCheckpointStatus;
}

/**
 * Crash-safe plan checkpoints stored with the workspace, one folder per
 * conversation. JSON is the machine source; Markdown makes the same state
 * reviewable without Atelier running.
 */
export class PlanCheckpointStore {
  private bindings = new Map<string, TaskBinding>();

  constructor(
    private workspaceRoot: string,
    private log: Logger
  ) {}

  bind(conversationId: string, taskId: string, request: string): void {
    this.bindings.set(taskId, { conversationId, taskId, request });
  }

  save(plan: Plan): void {
    const binding = this.bindings.get(plan.taskId);
    if (!binding) return;
    const checkpoint: PlanCheckpoint = {
      version: CHECKPOINT_VERSION,
      ...binding,
      updatedAt: Date.now(),
      plan,
    };
    try {
      const dir = this.conversationDir(binding.conversationId);
      fs.mkdirSync(dir, { recursive: true });
      atomicWrite(
        path.join(dir, `${safeId(binding.taskId)}.json`),
        JSON.stringify(checkpoint, null, 2) + "\n"
      );
      atomicWrite(
        path.join(dir, `${safeId(binding.taskId)}.md`),
        renderMarkdown(checkpoint)
      );
    } catch (error) {
      // A recovery side record must never fail the task it is protecting.
      this.log.warn(
        { err: error, taskId: plan.taskId },
        "could not persist plan checkpoint"
      );
    }
  }

  release(taskId: string): void {
    this.bindings.delete(taskId);
  }

  /** Unfinished plan for the task immediately preceding a continuation. */
  resumeContext(conversationId: string, previousTaskId: string): string {
    const checkpoint = this.incompleteForTask(conversationId, previousTaskId);
    if (!checkpoint) return "";
    const done = checkpoint.plan.steps.filter((step) => step.status === "done");
    const current = checkpoint.plan.steps.filter(
      (step) => step.status === "in-progress"
    );
    const todo = checkpoint.plan.steps.filter((step) => step.status === "pending");
    return [
      "RECOVERED EXECUTION PLAN (persisted before the previous run stopped):",
      `Original request: ${checkpoint.request}`,
      `Goal: ${checkpoint.plan.goal}`,
      section("Done", done),
      section("In progress when interrupted", current),
      section("Todo", todo),
      "Continue from this state. Verify the current workspace before editing; do not repeat completed steps unless verification shows they are incomplete.",
      `Checkpoint: .atelier/plans/${safeId(conversationId)}/${safeId(checkpoint.taskId)}.md`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  /**
   * The newest checkpointed plan of a conversation, whatever state it is
   * in. Where resumeContext asks "is there unfinished work to pick up",
   * this asks "what did the last turn plan and how did it end" — the
   * question a fresh set_plan needs answered when it is about to repeat a
   * step the user already stopped.
   *
   * `excludeTaskId` keeps the caller's own task out of the answer: the
   * pipeline may have checkpointed a placeholder plan for it already.
   */
  lastCheckpoint(
    conversationId: string,
    excludeTaskId?: string
  ): LastPlanCheckpoint | null {
    const dir = this.conversationDir(conversationId);
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      return null;
    }
    let newest: PlanCheckpoint | null = null;
    for (const name of names) {
      const parsed = readCheckpoint(path.join(dir, name));
      if (!parsed || parsed.conversationId !== conversationId) continue;
      if (excludeTaskId && parsed.taskId === excludeTaskId) continue;
      if (!newest || parsed.updatedAt > newest.updatedAt) newest = parsed;
    }
    if (!newest) return null;
    return {
      taskId: newest.taskId,
      request: newest.request,
      plan: newest.plan,
      status: checkpointStatus(newest.plan),
    };
  }

  removeConversation(conversationId: string): void {
    for (const [taskId, binding] of this.bindings) {
      if (binding.conversationId === conversationId) {
        this.bindings.delete(taskId);
      }
    }
    const dir = this.conversationDir(conversationId);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      this.log.warn(
        { err: error, conversationId },
        "could not remove conversation plan checkpoints"
      );
    }
  }

  private incompleteForTask(
    conversationId: string,
    taskId: string
  ): PlanCheckpoint | null {
    const parsed = readCheckpoint(
      path.join(this.conversationDir(conversationId), `${safeId(taskId)}.json`)
    );
    if (
      !parsed ||
      parsed.conversationId !== conversationId ||
      parsed.taskId !== taskId ||
      !parsed.plan.steps.some(
        (step) => step.status === "pending" || step.status === "in-progress"
      )
    ) {
      return null;
    }
    return parsed;
  }

  private conversationDir(conversationId: string): string {
    return path.join(
      this.workspaceRoot,
      ".atelier",
      "plans",
      safeId(conversationId)
    );
  }
}

/**
 * One checkpoint file, or null. Missing or truncated files never throw:
 * a recovery side record must not fail the turn that consults it, and an
 * unreadable checkpoint does not authorize reviving an older, unrelated
 * plan from elsewhere in the conversation.
 */
function readCheckpoint(file: string): PlanCheckpoint | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PlanCheckpoint;
    if (
      parsed.version !== CHECKPOINT_VERSION ||
      typeof parsed.taskId !== "string" ||
      !Array.isArray(parsed.plan?.steps)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function checkpointStatus(plan: Plan): PlanCheckpointStatus {
  if (plan.steps.some((step) => step.status === "cancelled")) return "cancelled";
  const settled = plan.steps.every(
    (step) => step.status === "done" || step.status === "skipped"
  );
  return settled ? "complete" : "unfinished";
}

function atomicWrite(target: string, content: string): void {
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, "utf8");
  fs.renameSync(temp, target);
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function section(
  title: string,
  steps: Plan["steps"]
): string {
  if (steps.length === 0) return `${title}: none`;
  return `${title}:\n${steps.map((step) => `- ${step.title}${step.note ? ` — ${step.note}` : ""}`).join("\n")}`;
}

function renderMarkdown(checkpoint: PlanCheckpoint): string {
  const rows = checkpoint.plan.steps.map((step) => {
    const mark = step.status === "done" ? "x" : " ";
    const detail = step.detail ? `\n  - ${step.detail}` : "";
    const files = step.files.length > 0 ? `\n  - Files: ${step.files.join(", ")}` : "";
    const note = step.note ? `\n  - Note: ${step.note}` : "";
    const verified = step.verification
      ? `\n  - Verified: ${step.verification}`
      : "";
    return (
      `- [${mark}] **${step.title}** \`${step.status}\`` +
      `${detail}${files}${verified}${note}`
    );
  });
  return [
    `# ${checkpoint.plan.goal}`,
    "",
    `- Conversation: \`${checkpoint.conversationId}\``,
    `- Task: \`${checkpoint.taskId}\``,
    `- Updated: ${new Date(checkpoint.updatedAt).toISOString()}`,
    "",
    "## Original request",
    "",
    checkpoint.request,
    "",
    "## Execution plan",
    "",
    ...rows,
    "",
  ].join("\n");
}
