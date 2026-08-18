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

  /** Latest plan that still has work open, excluding the new continuation. */
  resumeContext(conversationId: string, excludeTaskId: string): string {
    const checkpoint = this.latestIncomplete(conversationId, excludeTaskId);
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

  private latestIncomplete(
    conversationId: string,
    excludeTaskId: string
  ): PlanCheckpoint | null {
    const dir = this.conversationDir(conversationId);
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      return null;
    }
    const candidates: PlanCheckpoint[] = [];
    for (const name of names) {
      try {
        const parsed = JSON.parse(
          fs.readFileSync(path.join(dir, name), "utf8")
        ) as PlanCheckpoint;
        if (
          parsed.version !== CHECKPOINT_VERSION ||
          parsed.conversationId !== conversationId ||
          parsed.taskId === excludeTaskId ||
          !Array.isArray(parsed.plan?.steps) ||
          !parsed.plan.steps.some(
            (step) => step.status === "pending" || step.status === "in-progress"
          )
        ) {
          continue;
        }
        candidates.push(parsed);
      } catch {
        // A truncated file cannot win over an older valid checkpoint.
      }
    }
    candidates.sort((a, b) => b.updatedAt - a.updatedAt);
    return candidates[0] ?? null;
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
    return `- [${mark}] **${step.title}** \`${step.status}\`${detail}${files}${note}`;
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
