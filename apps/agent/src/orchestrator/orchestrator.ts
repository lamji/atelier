import type { Logger } from "pino";
import type { Diff, ImageAttachment } from "@atelier/protocol";
import { newId } from "@atelier/shared";
import type { EventBus, PublishedEvent } from "../events/event-bus.js";
import type { ConversationRepo } from "../storage/repositories/conversations.js";
import { isAuthError } from "./auth-status.js";
import {
  HookBlockedError,
  PipelineExecutor,
  type PipelineDeps,
  type TaskContext,
} from "./pipeline-executor.js";
import type { PlanTracker } from "./plan-tracker.js";

interface RunningTask {
  taskId: string;
  conversationId: string;
  abort: AbortController;
}

export interface TaskOptions {
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  planMode?: boolean;
  /** Images the model should see on the first turn of this task. */
  images?: ImageAttachment[];
}

export interface OrchestratorDeps extends PipelineDeps {
  conversations: ConversationRepo;
  planTracker: PlanTracker;
  log: Logger;
}

/**
 * Task lifecycle owner: persistence, events, cancellation. Every task
 * body runs through the 9-stage PipelineExecutor — the SDK is never
 * invoked outside a pipeline stage.
 */
export class Orchestrator {
  private running = new Map<string, RunningTask>();
  private pipeline: PipelineExecutor;
  private bus: EventBus;
  private conversations: ConversationRepo;
  private planTracker: PlanTracker;
  private log: Logger;

  constructor(deps: OrchestratorDeps) {
    this.pipeline = new PipelineExecutor(deps);
    this.bus = deps.bus;
    this.conversations = deps.conversations;
    this.planTracker = deps.planTracker;
    this.log = deps.log;
    // Pins diffs and knowledge/impact logs into chat history so they
    // survive a hydrate (session reload / reconnect), matching what the
    // live transcript already shows while the task is running.
    this.bus.subscribe((event) => this.onEvent(event));
  }

  private onEvent(event: PublishedEvent): void {
    if (!isPinnedTopic(event.topic)) return;
    const task = event.taskId ? this.running.get(event.taskId) : undefined;
    if (!task) return;
    if (event.topic === "diff.created") {
      const diff = event.payload as Diff;
      this.conversations.addMessage({
        id: diff.id,
        conversationId: task.conversationId,
        taskId: event.taskId,
        role: "diff",
        text: diff.path,
        createdAt: Date.now(),
        diff: { path: diff.path, before: diff.before, after: diff.after },
      });
      return;
    }
    const payload = event.payload as Record<string, unknown>;
    this.conversations.addMessage({
      id: `${event.topic}:${event.seq}`,
      conversationId: task.conversationId,
      taskId: event.taskId,
      role: "log",
      text: logSummary(event.topic, payload),
      createdAt: Date.now(),
      logTopic: event.topic,
    });
  }

  startTask(
    conversationId: string,
    prompt: string,
    opts: TaskOptions = {}
  ): string {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    for (const task of this.running.values()) {
      if (task.conversationId === conversationId) {
        throw new Error(
          "This agent session is already running a task; wait or cancel it. " +
            "Start another session to run tasks in parallel."
        );
      }
    }
    if (conversation.title === "New conversation") {
      this.conversations.setTitle(
        conversationId,
        prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt
      );
    }
    const taskId = newId("task");
    const abort = new AbortController();
    this.running.set(taskId, { taskId, conversationId, abort });

    this.conversations.createTask({
      id: taskId,
      conversationId,
      prompt,
      status: "running",
      startedAt: Date.now(),
      endedAt: null,
    });
    this.conversations.addMessage({
      id: newId("msg"),
      conversationId,
      taskId,
      role: "user",
      text: prompt,
      createdAt: Date.now(),
    });

    void this.runTask(taskId, conversationId, prompt, abort, opts).catch(
      (error) => {
        this.log.error({ err: error, taskId }, "task crashed");
      }
    );
    return taskId;
  }

  cancelTask(taskId: string): boolean {
    const task = this.running.get(taskId);
    if (!task) return false;
    task.abort.abort();
    return true;
  }

  listRunningTaskIds(): string[] {
    return [...this.running.keys()];
  }

  private async runTask(
    taskId: string,
    conversationId: string,
    prompt: string,
    abort: AbortController,
    opts: TaskOptions = {}
  ): Promise<void> {
    const startedAt = Date.now();
    const conversation = this.conversations.get(conversationId);
    const messageId = newId("msg");

    this.bus.publish("task.started", { conversationId, prompt }, taskId);
    this.bus.publish("agent.status", { status: "working" }, taskId);

    // The current user turn is already persisted (added on enqueue), so it is
    // the last user message — drop it and keep a short recent tail as the
    // retrieval anchor for follow-ups that omit the subject.
    const userTurns = this.conversations
      .getMessages(conversationId)
      .filter((m) => m.role === "user")
      .map((m) => m.text);
    const priorPrompts = userTurns.slice(0, -1).slice(-3);

    const ctx: TaskContext = {
      taskId,
      conversationId,
      prompt,
      priorPrompts,
      messageId,
      opts,
      abort,
      sdkSessionId: conversation?.sdkSessionId ?? null,
      onSdkSessionId: (sid) =>
        this.conversations.setSdkSessionId(conversationId, sid),
      collectedText: "",
    };

    try {
      const outcome = await this.pipeline.run(ctx);
      this.finishTask(taskId, conversationId, messageId, outcome.assistantText, {
        status: "completed",
        startedAt,
      });
    } catch (error) {
      if (abort.signal.aborted) {
        this.planTracker.cancelPending(taskId);
        this.finishTask(taskId, conversationId, messageId, ctx.collectedText, {
          status: "cancelled",
          startedAt,
        });
        return;
      }
      if (isAuthError(error)) {
        this.bus.publish(
          "agent.status",
          {
            status: "waiting-auth",
            detail: "Claude login required. Run `claude` and use /login.",
          },
          taskId
        );
      }
      const message =
        error instanceof HookBlockedError
          ? `Blocked by hook: ${error.message}`
          : String(error);
      this.log.error({ err: error, taskId }, "task failed");
      this.bus.publish("task.error", { conversationId, message }, taskId);
      this.conversations.updateTaskStatus(taskId, "error", Date.now());
      this.running.delete(taskId);
      this.planTracker.clear(taskId);
      this.publishGlobalStatus();
    }
  }

  private finishTask(
    taskId: string,
    conversationId: string,
    messageId: string,
    assistantText: string,
    outcome: { status: "completed" | "cancelled"; startedAt: number }
  ): void {
    if (assistantText) {
      this.conversations.addMessage({
        id: messageId,
        conversationId,
        taskId,
        role: "assistant",
        text: assistantText,
        createdAt: Date.now(),
      });
      this.bus.publish(
        "chat.message.completed",
        { conversationId, messageId, text: assistantText },
        taskId
      );
    }
    this.conversations.touch(conversationId);
    this.conversations.updateTaskStatus(taskId, outcome.status, Date.now());
    this.running.delete(taskId);
    this.planTracker.clear(taskId);
    if (outcome.status === "completed") {
      this.bus.publish(
        "task.completed",
        { conversationId, durationMs: Date.now() - outcome.startedAt },
        taskId
      );
    } else {
      this.bus.publish("task.cancelled", { conversationId }, taskId);
    }
    this.publishGlobalStatus();
  }

  /** Global status reflects whether ANY session is still working. */
  private publishGlobalStatus(): void {
    this.bus.publish("agent.status", {
      status: this.running.size > 0 ? "working" : "idle",
    });
  }
}

const PINNED_TOPICS = new Set([
  "diff.created",
  "knowledge.retrieved",
  "impact.radius",
  "edit.impact",
]);

function isPinnedTopic(topic: string): boolean {
  return PINNED_TOPICS.has(topic);
}

/**
 * Summary line for a knowledge/impact log pinned into chat history. Mirrors
 * apps/web/src/services/event-dispatcher.ts#logSummary so the persisted
 * text matches what was shown live.
 */
function logSummary(topic: string, payload: Record<string, unknown>): string {
  switch (topic) {
    case "knowledge.retrieved": {
      const chunks = Array.isArray(payload.chunks) ? payload.chunks.length : 0;
      return `Retrieved ${chunks} chunk(s) · ${String(payload.strategy ?? "")}`;
    }
    case "impact.radius":
      return String(payload.summary ?? "Impact radius computed");
    case "edit.impact": {
      const symbol = String(payload.symbol ?? "");
      const reach = String(payload.reach ?? "");
      const summary = String(payload.summary ?? "").slice(0, 90);
      return `${symbol} · ${reach} · ${summary}`;
    }
    default:
      return "";
  }
}
