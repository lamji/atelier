import type { Logger } from "pino";
import type { Diff, ImageAttachment, ReasoningEffort } from "@atelier/protocol";
import { conversationTitle, newId } from "@atelier/shared";
import type { EventBus, PublishedEvent } from "../events/event-bus.js";
import type { NoteJournal } from "../notes/note-journal.js";
import type { ConversationRepo } from "../storage/repositories/conversations.js";
import { isAuthError } from "./auth-status.js";
import {
  HookBlockedError,
  PipelineExecutor,
  newTaskRecord,
  type PipelineDeps,
  type TaskContext,
} from "./pipeline-executor.js";
import type { PlanTracker } from "./plan-tracker.js";
import { EMPTY_SCOPE } from "../workspace/scope/index.js";

interface RunningTask {
  taskId: string;
  conversationId: string;
  abort: AbortController;
}

export interface TaskOptions {
  model?: string;
  effort?: ReasoningEffort;
  planMode?: boolean;
  /** Vibe coding: autonomous product-builder mode for this task. */
  vibe?: boolean;
  /**
   * System knowledge — the full 10-stage pipeline (retrieval, impact,
   * plan, review, session memory). Absent means ON: only an explicit
   * `false` drops the task to a plain Claude/Codex agent loop.
   */
  systemKnowledge?: boolean;
  /**
   * Project directories this task is confined to, workspace-relative.
   * For callers that already know the answer (the git wizard's fix agent
   * knows its checkout) instead of leaving it to be parsed out of the
   * prompt.
   */
  scopeRoots?: string[];
  /** Images the model should see on the first turn of this task. */
  images?: ImageAttachment[];
  /** The `.atelier/*.md` note this prompt came from, if any. */
  promptFile?: string;
}

export interface OrchestratorDeps extends PipelineDeps {
  conversations: ConversationRepo;
  planTracker: PlanTracker;
  notes: NoteJournal;
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
  private notes: NoteJournal;
  private log: Logger;

  constructor(deps: OrchestratorDeps) {
    this.pipeline = new PipelineExecutor(deps);
    this.bus = deps.bus;
    this.conversations = deps.conversations;
    this.planTracker = deps.planTracker;
    this.notes = deps.notes;
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
    // Pinning history is a side effect of the task, never a reason to fail
    // it: a storage hiccup here must not surface as a failed request.
    try {
      this.pinToHistory(event, task);
    } catch (error) {
      this.log.warn({ err: error, topic: event.topic }, "could not pin event");
    }
  }

  private pinToHistory(event: PublishedEvent, task: RunningTask): void {
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
      // taskId keeps this unique across agent restarts — the bus seq
      // counter is in-memory and restarts at 1, which used to collide
      // with rows an earlier run had already written to this conversation.
      id: `${event.topic}:${task.taskId}:${event.seq}`,
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
    // A note-driven prompt IS the note's whole text, so naming the
    // conversation after it would drop the file's body into the history
    // list. trackNote names it after the note's heading instead.
    if (conversation.title === "New conversation" && !opts.promptFile) {
      this.conversations.setTitle(conversationId, conversationTitle(prompt));
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

    // Fire and forget: the note is a side record, and startTask must stay
    // synchronous so the caller gets its task id back immediately.
    if (opts.promptFile) {
      void this.trackNote(conversationId, opts.promptFile);
    }

    void this.runTask(taskId, conversationId, prompt, abort, opts).catch(
      (error) => {
        this.log.error({ err: error, taskId }, "task crashed");
      }
    );
    return taskId;
  }

  /**
   * Points a conversation at the note that drove it: the history list reads
   * as the note's heading, and the note itself becomes work in progress.
   *
   * The title is re-applied on EVERY note-driven send, not only the first —
   * a note is the unit of work, so whatever was typed alongside it must not
   * name the session, and pointing a session at a different note renames it
   * to that note. A send with no note leaves the title alone as before.
   *
   * The title is read before the status is written so it can never observe
   * a half-written file.
   */
  private async trackNote(
    conversationId: string,
    notePath: string
  ): Promise<void> {
    try {
      const title = await this.notes.title(notePath);
      if (title) {
        this.conversations.setTitle(conversationId, conversationTitle(title));
      }
    } catch (error) {
      this.log.warn({ err: error, notePath }, "could not name a session after its note");
    }
    await this.notes.markInProgress(notePath);
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
    const messageId = newId("msg");

    this.bus.publish("task.started", { conversationId, prompt }, taskId);
    this.bus.publish("agent.status", { status: "working" }, taskId);

    // The current user turn is already persisted (added on enqueue). Exclude
    // it by task id and retain the prior exchange, including the assistant's
    // answer: "fix the gap" often refers to a gap named only in that answer.
    const priorTurns = this.conversations
      .getMessages(conversationId)
      .filter(
        (message) =>
          message.taskId !== taskId &&
          (message.role === "user" || message.role === "assistant")
      )
      .slice(-4)
      .map((message) => ({
        role: message.role as "user" | "assistant",
        text: message.text,
      }));

    const ctx: TaskContext = {
      taskId,
      conversationId,
      prompt,
      priorTurns,
      messageId,
      opts,
      abort,
      // Replaced by the real lock in the pipeline's first step; unlocked
      // is the safe default if that step ever fails.
      scope: EMPTY_SCOPE,
      // Cross-task continuity is Atelier-owned context, not a provider-native
      // session id. streamSession may still keep an in-memory id for the same
      // Claude task so validation/review repair rounds can continue cleanly.
      sdkSessionId: null,
      onSdkSessionId: () => undefined,
      collectedText: "",
      nudges: 0,
      record: newTaskRecord(),
    };

    try {
      const outcome = await this.pipeline.run(ctx);
      this.finishTask(taskId, conversationId, messageId, outcome.assistantText, {
        status: "completed",
        startedAt,
      });
      await this.writeNoteReport(ctx, {
        status: "completed",
        assistantText: outcome.assistantText,
        startedAt,
      });
    } catch (error) {
      if (abort.signal.aborted) {
        this.planTracker.cancelPending(taskId);
        await this.rememberInterrupted(ctx, "cancelled");
        this.finishTask(taskId, conversationId, messageId, ctx.collectedText, {
          status: "cancelled",
          startedAt,
        });
        await this.writeNoteReport(ctx, {
          status: "cancelled",
          assistantText: ctx.collectedText,
          startedAt,
        });
        return;
      }
      await this.rememberInterrupted(ctx, "error");
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
      await this.writeNoteReport(ctx, {
        status: "error",
        assistantText: ctx.collectedText,
        startedAt,
        errorMessage: message,
      });
    }
  }

  /**
   * Appends this run's record to the note that drove it, and moves the note
   * to `review` when the run finished. Runs AFTER the task has been reported
   * as done: the narrative pass costs a model call, and no user should wait
   * on a side record to learn their task is over.
   *
   * The plan steps come from ctx.record rather than the tracker — the
   * tracker entry is cleared as the task finishes, and the record already
   * carries the live statuses the summary stage copied into it.
   */
  private async writeNoteReport(
    ctx: TaskContext,
    outcome: {
      status: "completed" | "cancelled" | "error";
      assistantText: string;
      startedAt: number;
      errorMessage?: string;
    }
  ): Promise<void> {
    const notePath = ctx.opts.promptFile;
    if (!notePath) return;
    const record = ctx.record;
    try {
      await this.notes.writeReport(
        notePath,
        {
          taskId: ctx.taskId,
          status: outcome.status,
          request: ctx.prompt,
          intentKind: record.intentKind || "task",
          intentSummary: record.intentSummary,
          planGoal: record.planGoal,
          steps: record.steps,
          changedFiles: [...record.changedFiles],
          validation: record.validation,
          reviewVerdict: record.reviewVerdict,
          durationMs: Date.now() - outcome.startedAt,
          at: Date.now(),
          assistantText: outcome.assistantText,
          errorMessage: outcome.errorMessage,
        },
        { model: ctx.opts.model, effort: ctx.opts.effort }
      );
    } catch (error) {
      this.log.warn(
        { err: error, taskId: ctx.taskId, notePath },
        "could not write the task report to its note"
      );
    }
  }

  /**
   * A cancelled or crashed task still did work, and the next turn is often
   * "continue" on a different model. Writing its memory here is what keeps
   * that continuation possible — but it must never mask the original failure,
   * so a storage problem is logged and swallowed.
   */
  private async rememberInterrupted(
    ctx: TaskContext,
    status: "cancelled" | "error"
  ): Promise<void> {
    try {
      await this.pipeline.saveInterruptedSummary(ctx, status);
    } catch (error) {
      this.log.warn(
        { err: error, taskId: ctx.taskId },
        "could not save interrupted task summary"
      );
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
  "session.recalled",
  "skills.selected",
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
    case "session.recalled":
      return sessionRecalledSummary(payload);
    case "skills.selected": {
      const skills = Array.isArray(payload.skills) ? payload.skills : [];
      const names = skills
        .map((skill) =>
          typeof skill === "object" && skill && "name" in skill
            ? String((skill as { name?: unknown }).name ?? "")
            : ""
        )
        .filter(Boolean);
      return names.length > 0
        ? `Using skills: ${names.map((name) => `/${name}`).join(", ")}`
        : "No task skills selected";
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

/**
 * What the turn remembered, in one line. Mirrors the same function in
 * apps/web/src/services/event-dispatcher.ts so the pinned history text
 * matches what the console showed live.
 */
function sessionRecalledSummary(payload: Record<string, unknown>): string {
  const chunks = Number(payload.chunks ?? 0);
  const summaries = Number(payload.summaries ?? 0);
  const turns = Number(payload.turns ?? 0);
  const tokens = Number(payload.tokens ?? 0);
  const labels = Array.isArray(payload.labels)
    ? payload.labels.map(String).filter(Boolean)
    : [];
  const parts: string[] = [];
  if (chunks > 0) parts.push(`${chunks} memory chunk(s)`);
  if (summaries > 0) parts.push(`${summaries} task summary(ies)`);
  if (turns > 0) parts.push(`${turns} prior turn(s)`);
  const head = parts.length > 0 ? parts.join(" · ") : "nothing to recall";
  const tail = labels.length > 0 ? ` — ${labels.join("; ")}` : "";
  return `Recalled session: ${head} · ~${tokens} tok${tail}`;
}
