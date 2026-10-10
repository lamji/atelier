import type { Logger } from "pino";
import type { EventBus } from "../events/event-bus.js";
import type { FileService } from "../workspace/file-service.js";
import {
  buildTaskSummary,
  type TaskSummaryStore,
} from "../context/summaries/index.js";
import type { WorkingMemoryStore } from "../context/working-memory/working-memory-store.js";
import {
  isOllamaModel,
  ollamaModelName,
  ollamaTargetOf,
} from "../providers/model-routing.js";
import { resolveNumCtx } from "../providers/ollama/client.js";
import type { SkillLoader } from "./skill-loader.js";
import { isTrivialChat } from "./trivial-chat.js";
import type { TaskContext } from "./pipeline-executor.js";
import { renderPriorTurns } from "./direct-mode.js";

/**
 * The agent flow. One turn is:
 *
 *   1. context  — what this chat already said, did and read; the skill the
 *                 user invoked; the images they attached.
 *   2. one call — the model, with every tool, running until IT decides it
 *                 is done. Nothing here refuses a tool call, erases a
 *                 report, re-prompts the model or restarts it.
 *   3. memory   — a compressed record of the turn for the next one.
 *
 * That is the whole flow. There is no intent classifier, scope lock,
 * retrieval stage, plan stage, review, validation, completion gate, nudge
 * or continuation harness. The staged pipeline those belonged to refused
 * the model's own tool calls 58 times in one afternoon and hid its
 * reports; it is unreachable now (see isDirectMode).
 *
 * Provider transport stays where it was — `PipelineExecutor.streamSession`
 * knows how to talk to Claude, Codex, Ollama and Grok — and is handed in as
 * a function, so this file owns the FLOW and nothing else.
 */
export interface TurnTransport {
  (
    ctx: TaskContext,
    prompt: string,
    context: string,
    images: TaskContext["images"]
  ): Promise<{ text: string }>;
}

export interface TurnRunnerDeps {
  bus: EventBus;
  log: Logger;
  files: FileService;
  summaries: TaskSummaryStore;
  workingMemory?: WorkingMemoryStore;
  skillLoader: SkillLoader;
}

export interface TurnResult {
  text: string;
}

/**
 * Tokens of previously read files inlined per turn. The CLI pays for the
 * whole transcript again on every request; this pays once for the current
 * bytes of the files the last turns actually opened, so a follow-up starts
 * from them instead of re-reading. Generous on purpose — re-reading costs
 * more, in tokens and in tool calls.
 */
const GATHERED_TOKENS = 6_000;
/** Share of a small local window the gathered block may take. */
const GATHERED_WINDOW_SHARE = 0.15;

export class TurnRunner {
  constructor(private deps: TurnRunnerDeps) {}

  async run(ctx: TaskContext, transport: TurnTransport): Promise<TurnResult> {
    const forget = this.remember(ctx);
    try {
      const context = await this.context(ctx);
      const { text } = await transport(ctx, ctx.prompt, context, ctx.images);
      this.saveSummary(ctx, text, "completed");
      return { text };
    } finally {
      forget();
    }
  }

  /**
   * Everything the model is given besides the prompt and the static rules.
   * Each block is bounded by its own budget; nothing here is a model call.
   */
  async context(ctx: TaskContext): Promise<string> {
    // Ollama already receives these messages as its native chat history.
    const conversation = isOllamaModel(ctx.opts.model) ? "" : renderPriorTurns(ctx.priorTurns);
    const gathered = await this.gathered(ctx);
    const skills = this.skills(ctx);
    return [
      conversation,
      gathered,
      attachmentBlock(ctx),
      skills,
      ctx.recoveryPlan,
    ]
      .filter((block) => block.trim().length > 0)
      .join("\n\n");
  }

  /** The current bytes of files earlier turns opened, while budget lasts. */
  private async gathered(ctx: TaskContext): Promise<string> {
    const store = this.deps.workingMemory;
    if (!store) return "";
    if (isTrivialChat(ctx.humanPrompt, ctx.images.length > 0)) return "";
    try {
      const window = await this.window(ctx);
      const maxTokens = Math.min(
        GATHERED_TOKENS,
        window ? Math.floor(window * GATHERED_WINDOW_SHARE) : Infinity
      );
      // Files an attempt the user STOPPED had opened are listed, never
      // inlined as "what you hold": the stop usually meant "wrong file".
      const demoteTaskIds = new Set(
        this.deps.summaries
          .recent(ctx.conversationId, 8)
          .filter((summary) => summary.status && summary.status !== "completed")
          .map((summary) => summary.taskId)
      );
      const recalled = await store.recall({
        conversationId: ctx.conversationId,
        currentTaskId: ctx.taskId,
        files: this.deps.files,
        maxTokens,
        demoteTaskIds,
      });
      if (recalled.tokens > 0) {
        this.deps.bus.publish(
          "working-memory.reused",
          {
            inlined: recalled.inlined,
            listed: recalled.listed,
            changed: recalled.changed,
            searches: recalled.searches,
            tokens: recalled.tokens,
            paths: recalled.inlinedPaths,
            seeded: recalled.seeded,
            demoted: recalled.demoted,
            located: recalled.located,
          },
          ctx.taskId
        );
      }
      return recalled.text;
    } catch (error) {
      this.deps.log.warn({ err: error }, "working memory recall failed");
      return "";
    }
  }

  /** The skill the user invoked with a leading /name, if any. */
  private skills(ctx: TaskContext): string {
    const loaded = this.deps.skillLoader.load(ctx.humanPrompt);
    if (loaded.skills.length > 0) {
      this.deps.bus.publish(
        "skills.selected",
        {
          skills: loaded.skills.map((skill) => ({
            id: skill.id,
            name: skill.name,
          })),
        },
        ctx.taskId
      );
    }
    return loaded.context;
  }

  /** A local model's window, when the turn runs on one. */
  private async window(ctx: TaskContext): Promise<number | undefined> {
    if (!isOllamaModel(ctx.opts.model)) return undefined;
    return resolveNumCtx(
      ollamaModelName(ctx.opts.model as string),
      ollamaTargetOf(ctx.opts.model) ?? "ollama-cloud"
    ).catch(() => undefined);
  }

  /**
   * Records what the turn DOES — reads, searches, commands, edits — into the
   * conversation's working memory for the next turn. Returns the
   * unsubscribe. Memory is a side effect of the turn, never a way to fail it.
   */
  remember(ctx: TaskContext): () => void {
    const store = this.deps.workingMemory;
    if (!store) return () => undefined;
    const inputs = new Map<string, unknown>();
    return this.deps.bus.subscribe((event) => {
      if (event.taskId !== ctx.taskId) return;
      try {
        if (event.topic === "tool.started") {
          const payload = event.payload as { toolCallId: string; input: unknown };
          inputs.set(payload.toolCallId, payload.input);
        } else if (event.topic === "tool.failed") {
          inputs.delete((event.payload as { toolCallId: string }).toolCallId);
        } else if (event.topic === "tool.completed") {
          const payload = event.payload as {
            toolCallId?: string;
            name?: string;
            result?: unknown;
          };
          if (!payload.toolCallId || !payload.name) return;
          const input = inputs.get(payload.toolCallId);
          inputs.delete(payload.toolCallId);
          if (input === undefined) return;
          store.noteTool({
            conversationId: ctx.conversationId,
            taskId: ctx.taskId,
            name: payload.name,
            input,
            result: payload.result,
          });
        } else if (event.topic === "edit.applied") {
          store.noteEdit({
            conversationId: ctx.conversationId,
            taskId: ctx.taskId,
            path: (event.payload as { path: string }).path,
          });
        }
      } catch (error) {
        this.deps.log.warn({ err: error }, "could not note tool result");
      }
    });
  }

  /**
   * The compressed record of the turn, built locally from what the turn
   * already has. It is what lets the turn after next know what this one
   * did, and what a switch to another provider picks up.
   */
  saveSummary(
    ctx: TaskContext,
    assistantText: string,
    status: "completed" | "cancelled" | "error"
  ): void {
    if (ctx.record.summarized) return;
    const changedFiles = [...ctx.record.changedFiles];
    const text = assistantText.trim();
    if (changedFiles.length === 0 && !text) return;
    ctx.record.summarized = true;
    ctx.record.intentKind = "direct";
    ctx.record.intentSummary = clip(ctx.humanPrompt, 120);
    const saved = this.deps.summaries.save(
      buildTaskSummary({
        taskId: ctx.taskId,
        conversationId: ctx.conversationId,
        intentSummary: ctx.record.intentSummary,
        originalPrompt: ctx.humanPrompt,
        attachmentPaths: ctx.imagePaths,
        assistantText: text,
        changedFiles,
        validation: [],
        planGoal: "",
        status,
        partialText: text,
        answerTurn: changedFiles.length === 0 && text.length > 0,
      })
    );
    void saved.catch((error) =>
      this.deps.log.warn({ err: error }, "summary not saved")
    );
  }
}

/** The conversation's images, by path, so a later turn can open one. */
function attachmentBlock(ctx: TaskContext): string {
  if (ctx.imagePaths.length === 0) return "";
  const shown = ctx.images.length > 0;
  return (
    "ATTACHED IMAGES (open one with view_image when the request refers to " +
    `it${shown ? "; the current ones are also inline in this message" : ""}):\n` +
    ctx.imagePaths.map((path) => `- ${path}`).join("\n")
  );
}

function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}
