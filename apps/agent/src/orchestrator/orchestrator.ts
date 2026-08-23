import type { Logger } from "pino";
import type {
  Diff,
  ImageAttachment,
  LlmRequest,
  ReasoningEffort,
} from "@atelier/protocol";
import {
  conversationTitle,
  llmRequestDetail,
  llmRequestSummary,
  newId,
} from "@atelier/shared";
import type { EventBus, PublishedEvent } from "../events/event-bus.js";
import type { AttachmentStore } from "../context/attachments/attachment-store.js";
import type { NoteJournal } from "../notes/note-journal.js";
import type { NoteAccessRegistry } from "../notes/note-access.js";
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
  /** A cancel was sent; further cancels are no-ops. */
  cancelling: boolean;
  /** Backstop that closes the session if the run never unwinds. */
  forceTimer?: NodeJS.Timeout;
}

/**
 * A send that arrived while its conversation was busy. Persisted and shown
 * in the transcript straight away; started when the conversation frees up.
 */
interface QueuedTask {
  taskId: string;
  conversationId: string;
  prompt: string;
  opts: TaskOptions;
}

/**
 * How long a cancelled run gets to unwind on its own before the session is
 * closed out from under it. A stage that is not abort-aware (an embedding
 * pass, a shell command mid-flight) can outlive its signal, and a task left
 * in `running` blocks every later send on that conversation — the stop
 * button appearing to do nothing at all.
 */
const CANCEL_GRACE_MS = 4000;

/** Explicit continuation language opts into the newest unfinished checkpoint. */
function isResumePrompt(prompt: string): boolean {
  return /\b(continue|resume|pick\s+up|carry\s+on)\b/i.test(prompt);
}

export interface TaskOptions {
  model?: string;
  effort?: ReasoningEffort;
  planMode?: boolean;
  /** Vibe coding: autonomous product-builder mode for this task. */
  vibe?: boolean;
  /**
   * Independent review after the changes land. Absent means OFF: only an
   * explicit `true` runs the review stage and its repair rounds. It is the
   * most expensive thing a turn can do after the answer is already on
   * screen, so an interactive send does not pay for it by default.
   */
  autoReview?: boolean;
  /**
   * Run the validators over what the task changed. Absent means OFF: only
   * an explicit `true` runs typecheck/lint/test. They are package scripts
   * over the whole project, they start after the answer has finished
   * streaming, and the turn cannot end until they return — minutes spent
   * where the user is already reading the result.
   */
  autoValidate?: boolean;
  /**
   * System knowledge — the full pipeline (retrieval, plan, validation,
   * review, session memory). Absent means ON: only an explicit `false`
   * drops the task to a plain Claude/Codex agent loop.
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
  noteAccess: NoteAccessRegistry;
  log: Logger;
}

/**
 * Task lifecycle owner: persistence, events, cancellation. Every task
 * body runs through the 9-stage PipelineExecutor — the SDK is never
 * invoked outside a pipeline stage.
 */
export class Orchestrator {
  private running = new Map<string, RunningTask>();
  /** Follow-ups waiting on a busy conversation, oldest first. */
  private queue: QueuedTask[] = [];
  private pipeline: PipelineExecutor;
  private bus: EventBus;
  private conversations: ConversationRepo;
  private planTracker: PlanTracker;
  private notes: NoteJournal;
  private noteAccess: NoteAccessRegistry;
  private attachments: AttachmentStore;
  private log: Logger;

  constructor(deps: OrchestratorDeps) {
    this.pipeline = new PipelineExecutor(deps);
    this.bus = deps.bus;
    this.conversations = deps.conversations;
    this.planTracker = deps.planTracker;
    this.notes = deps.notes;
    this.noteAccess = deps.noteAccess;
    this.attachments = deps.attachments;
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
    const detail = logDetail(event.topic, payload);
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
      ...(detail ? { logDetail: detail } : {}),
    });
  }

  /**
   * Accepts a turn. If the conversation is already working, the turn is
   * QUEUED rather than refused.
   *
   * This used to throw, which made the composer's only answer to "that's not
   * what I meant" a cancel — losing the run in flight and everything it had
   * already established. A follow-up is now persisted and shown immediately,
   * and starts by itself the moment the conversation frees up, so a
   * correction costs nothing but its turn in line.
   */
  startTask(
    conversationId: string,
    prompt: string,
    opts: TaskOptions = {}
  ): { taskId: string; queued: boolean } {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    const busy = this.busyWith(conversationId);
    // A note-driven prompt IS the note's whole text, so naming the
    // conversation after it would drop the file's body into the history
    // list. trackNote names it after the note's heading instead.
    if (conversation.title === "New conversation" && !opts.promptFile) {
      this.conversations.setTitle(conversationId, conversationTitle(prompt));
    }
    const taskId = newId("task");

    this.conversations.createTask({
      id: taskId,
      conversationId,
      prompt,
      status: busy ? "queued" : "running",
      startedAt: Date.now(),
      endedAt: null,
    });
    this.planTracker.bindTask(conversationId, taskId, prompt);
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

    if (busy) {
      this.queue.push({ taskId, conversationId, prompt, opts });
      this.bus.publish(
        "task.queued",
        {
          conversationId,
          prompt,
          position: this.queue.filter(
            (task) => task.conversationId === conversationId
          ).length,
        },
        taskId
      );
      return { taskId, queued: true };
    }

    this.launch(taskId, conversationId, prompt, opts);
    return { taskId, queued: false };
  }

  /** True while a task holds this conversation. */
  private busyWith(conversationId: string): boolean {
    for (const task of this.running.values()) {
      if (task.conversationId === conversationId) return true;
    }
    return false;
  }

  /**
   * Puts a task into flight. Split out of startTask so a queued turn takes
   * exactly the same path when its turn comes, without re-running the
   * persistence startTask already did.
   */
  private launch(
    taskId: string,
    conversationId: string,
    prompt: string,
    opts: TaskOptions
  ): void {
    // Which notes this turn may edit is a property of what was SENT, so it
    // is recorded here — before any tool runs — and dropped in release().
    this.noteAccess.grant(taskId, prompt, opts.promptFile);
    const abort = new AbortController();
    this.running.set(taskId, {
      taskId,
      conversationId,
      abort,
      cancelling: false,
    });
    void this.runTask(taskId, conversationId, prompt, abort, opts).catch(
      (error) => {
        this.log.error({ err: error, taskId }, "task crashed");
      }
    );
  }

  /**
   * Starts the next follow-up waiting on a conversation that just freed up.
   *
   * Runs after EVERY terminal outcome, cancel included: the queued text is
   * something the user typed and still expects an answer to, and silently
   * dropping it would lose work the composer has already cleared. A queued
   * turn they no longer want can be cancelled on its own id.
   *
   * The row's start time is re-stamped here so the elapsed counter measures
   * the run rather than the wait.
   */
  private startNextQueued(conversationId: string): void {
    if (this.busyWith(conversationId)) return;
    const index = this.queue.findIndex(
      (task) => task.conversationId === conversationId
    );
    if (index === -1) return;
    const [next] = this.queue.splice(index, 1);
    if (!next) return;
    // A conversation deleted while its follow-up waited has nothing to run.
    if (!this.conversations.get(conversationId)) return;
    this.conversations.startTask(next.taskId, Date.now());
    this.launch(next.taskId, conversationId, next.prompt, next.opts);
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

  /**
   * Stores what this turn attached and returns the conversation's current
   * image paths — this turn's own, or the last set it carried. A follow-up
   * therefore always knows an address for the picture it is asked about,
   * without the bytes being re-sent on every turn that never mentions it.
   */
  private attachmentPaths(
    conversationId: string,
    taskId: string,
    images: ImageAttachment[] | undefined
  ): string[] {
    this.attachments.save(conversationId, taskId, images);
    return this.attachments.recentPaths(conversationId);
  }

  cancelTask(taskId: string): boolean {
    // A queued turn has nothing to abort — dropping it from the line IS the
    // cancel, and it must report as cancelled so the transcript does not
    // keep showing a follow-up that will never run.
    const queuedAt = this.queue.findIndex((entry) => entry.taskId === taskId);
    if (queuedAt !== -1) {
      const [dropped] = this.queue.splice(queuedAt, 1);
      this.conversations.updateTaskStatus(taskId, "cancelled", Date.now());
      if (dropped) {
        this.bus.publish(
          "task.cancelled",
          { conversationId: dropped.conversationId },
          taskId
        );
      }
      return true;
    }
    const task = this.running.get(taskId);
    if (!task) return false;
    // Idempotent: a second click must not stack another backstop timer.
    if (task.cancelling) return true;
    task.cancelling = true;
    task.abort.abort();
    task.forceTimer = setTimeout(() => this.forceCancel(taskId), CANCEL_GRACE_MS);
    // The agent process must still be able to exit while one is pending.
    task.forceTimer.unref?.();
    return true;
  }

  /**
   * Closes a cancelled task that never unwound. The run itself may still be
   * winding down in the background — it finds its entry gone and stops short
   * of publishing a second lifecycle event — but the conversation is free
   * again, which is the part the user is waiting on.
   */
  private forceCancel(taskId: string): void {
    const task = this.running.get(taskId);
    if (!task) return;
    this.log.warn(
      { taskId },
      "cancelled task did not unwind in time; closing the session"
    );
    this.conversations.updateTaskStatus(taskId, "cancelled", Date.now());
    this.release(taskId);
    this.planTracker.clear(taskId);
    this.bus.publish(
      "task.cancelled",
      { conversationId: task.conversationId },
      taskId
    );
    this.startNextQueued(task.conversationId);
    this.publishGlobalStatus();
  }

  /** Drops a task from the live set, cancelling its backstop with it. */
  private release(taskId: string): void {
    const task = this.running.get(taskId);
    if (task?.forceTimer) clearTimeout(task.forceTimer);
    this.running.delete(taskId);
    this.noteAccess.release(taskId);
  }

  listRunningTaskIds(): string[] {
    return [...this.running.keys()];
  }

  /** Follow-ups waiting on a busy conversation, oldest first. */
  listQueuedTaskIds(): string[] {
    return this.queue.map((task) => task.taskId);
  }

  /**
   * Drops every follow-up waiting on a conversation, for a caller that is
   * about to delete it. Without this a queued turn could still win the race
   * against the running task's cancel and start against rows that are on
   * their way out.
   */
  dropQueued(conversationId: string): void {
    const dropped = this.queue.filter(
      (task) => task.conversationId === conversationId
    );
    if (dropped.length === 0) return;
    this.queue = this.queue.filter(
      (task) => task.conversationId !== conversationId
    );
    for (const task of dropped) {
      this.conversations.updateTaskStatus(task.taskId, "cancelled", Date.now());
    }
  }

  removePlanCheckpoints(conversationId: string): void {
    this.planTracker.removeConversation(conversationId);
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
      recoveryPlan: isResumePrompt(prompt)
        ? this.planTracker.resumeContext(conversationId, taskId)
        : "",
      priorTurns,
      messageId,
      images: opts.images ?? [],
      // chat_messages stores text, so an attachment left no trace there and
      // the next turn could not see the picture it was asked about. The
      // bytes go to disk and the path travels: into this turn's context,
      // into session memory, and back through view_image on any later turn.
      imagePaths: this.attachmentPaths(conversationId, taskId, opts.images),
      opts,
      abort,
      // One per task, filled by the first Ollama pass and continued by every
      // pass after it. Claude's equivalent is sdkSessionId, which the SDK
      // fills the same way.
      ollamaTranscript: { messages: [] },
      // Replaced by the real lock in the pipeline's first step; unlocked
      // is the safe default if that step ever fails.
      scope: EMPTY_SCOPE,
      // Filled by the retrieve stage from the lock and this turn's hits.
      workingSet: [],
      // Cross-task continuity is Atelier-owned context, not a provider-native
      // session id. streamSession may still keep an in-memory id for the same
      // Claude task so validation/review repair rounds can continue cleanly.
      sdkSessionId: null,
      onSdkSessionId: () => undefined,
      collectedText: "",
      nudges: 0,
      gateNudges: 0,
      // The execute stage sets this from the intent; until then the safe
      // default is "this turn owes no edit", so nothing pushes to implement.
      mustEdit: false,
      turnLimitContinuations: 0,
      turnLimitStalls: 0,
      wiki: [],
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
        // Step statuses are read off the tracker before finishTask clears it;
        // the memory write itself happens after the task is reported over.
        // It embeds, which costs seconds — and a user who pressed stop must
        // not sit in "Stopping…" waiting on a record they never asked for.
        this.pipeline.captureLivePlanSteps(ctx);
        this.finishTask(taskId, conversationId, messageId, ctx.collectedText, {
          status: "cancelled",
          startedAt,
        });
        await this.rememberInterrupted(ctx, "cancelled");
        await this.writeNoteReport(ctx, {
          status: "cancelled",
          assistantText: ctx.collectedText,
          startedAt,
        });
        return;
      }
      this.pipeline.captureLivePlanSteps(ctx);
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
      // Absent means the backstop already closed this task; the failure is
      // still worth logging, a second lifecycle event is not.
      if (this.running.has(taskId)) {
        this.bus.publish("task.error", { conversationId, message }, taskId);
        this.conversations.updateTaskStatus(taskId, "error", Date.now());
        this.release(taskId);
        this.planTracker.clear(taskId);
        this.startNextQueued(conversationId);
        this.publishGlobalStatus();
      }
      // Same ordering as the cancel path: report first, remember after.
      await this.rememberInterrupted(ctx, "error");
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
    // A run whose entry is gone was already closed by the cancel backstop.
    // Whatever it managed to say is still worth keeping — the lifecycle
    // event is not, and re-publishing it would restart the composer's
    // "working" state on a session the user has moved on from.
    const live = this.running.has(taskId);
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
    if (!live) return;
    this.conversations.updateTaskStatus(taskId, outcome.status, Date.now());
    this.release(taskId);
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
    this.startNextQueued(conversationId);
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
  "working-memory.reused",
  "scope.escaped",
  "wiki.recalled",
  "wiki.updated",
  "llm.request",
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
    case "working-memory.reused":
      return workingMemorySummary(payload);
    case "wiki.recalled": {
      const pages = Array.isArray(payload.pages) ? payload.pages : [];
      const labels = pages.map((page) => {
        const p = page as { title?: string; moved?: string[] };
        const moved = Array.isArray(p.moved) ? p.moved.length : 0;
        return `${String(p.title ?? "")}${moved > 0 ? ` (stale: ${moved} source(s) moved)` : ""}`;
      });
      return `Feature wiki: ${labels.join("; ") || "no page"} · ~${Number(payload.tokens ?? 0)} tok`;
    }
    case "wiki.updated": {
      const sections = Array.isArray(payload.changedSections)
        ? payload.changedSections.map(String)
        : [];
      const what = payload.created ? "created" : "updated";
      const detail = sections.length > 0 ? ` — ${sections.slice(0, 4).join(", ")}` : "";
      return `Feature wiki ${what}: ${String(payload.title ?? "")} (${String(payload.path ?? "")})${detail}`;
    }
    case "scope.escaped":
      return `Scope lock let ${String(payload.tool ?? "a tool")} through to ${String(payload.path ?? "")}`;
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
    case "llm.request":
      return llmRequestSummary(payload as unknown as LlmRequest);
    default:
      return "";
  }
}

/**
 * The long-form body behind a pinned log line, when the event has one.
 * Only the model-request row carries a body today: the full context that
 * was sent, so "what did it know when it did that?" can be answered from
 * a reloaded conversation, not just from the live run.
 */
function logDetail(topic: string, payload: Record<string, unknown>): string {
  if (topic !== "llm.request") return "";
  return llmRequestDetail(payload as unknown as LlmRequest);
}


/**
 * What earlier turns' investigation this turn started from, in one line.
 * Mirrored in apps/web/src/services/event-dispatcher.ts.
 */
function workingMemorySummary(payload: Record<string, unknown>): string {
  const inlined = Number(payload.inlined ?? 0);
  const listed = Number(payload.listed ?? 0);
  const changed = Number(payload.changed ?? 0);
  const searches = Number(payload.searches ?? 0);
  const tokens = Number(payload.tokens ?? 0);
  const paths = Array.isArray(payload.paths)
    ? payload.paths.map(String).filter(Boolean)
    : [];
  const parts: string[] = [];
  if (inlined > 0) parts.push(`${inlined} file(s) re-used from earlier turns`);
  if (changed > 0) parts.push(`${changed} changed since`);
  if (listed > 0) parts.push(`${listed} more remembered by path`);
  const seeded = Number(payload.seeded ?? 0);
  if (seeded > 0) parts.push(`${seeded} owner file(s) from the feature wiki`);
  if (searches > 0) parts.push(`${searches} earlier search(es)`);
  const head = parts.length > 0 ? parts.join(" · ") : "nothing to reuse";
  const tail =
    paths.length > 0
      ? ` — ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ", …" : ""}`
      : "";
  return `Reused gathered context: ${head} · ~${tokens} tok${tail}`;
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
