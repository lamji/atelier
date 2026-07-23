import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";
import { newId } from "@atelier/shared";
import type { AgentConfig } from "../config/agent-config.js";
import type { EventBus } from "../events/event-bus.js";
import type { ConversationRepo } from "../storage/repositories/conversations.js";
import type { ToolRegistry } from "../tools/registry.js";
import { isAuthError } from "./auth-status.js";
import {
  createAtelierMcpServer,
  MCP_SERVER_NAME,
  type SdkToolContext,
} from "./sdk-tools.js";

/**
 * Built-in SDK tools are disabled: every capability the model gets must go
 * through Atelier's own tool registry (Phase 2+) so hooks, diffs, and events
 * are never bypassed.
 */
const DISABLED_BUILTINS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Task",
  "TodoWrite",
  "NotebookEdit",
];

interface RunningTask {
  taskId: string;
  conversationId: string;
  abort: AbortController;
}

export interface TaskOptions {
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  planMode?: boolean;
}

/**
 * Phase 1 orchestrator: a plain streaming pass-through to the Claude Agent
 * SDK. The 9-stage pipeline executor replaces the direct call path in
 * Phase 6; the surface (startTask/cancelTask) stays the same.
 */
export class Orchestrator {
  private running = new Map<string, RunningTask>();

  constructor(
    private config: AgentConfig,
    private bus: EventBus,
    private conversations: ConversationRepo,
    private tools: ToolRegistry,
    private log: Logger
  ) {}

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
    let assistantText = "";
    let sdkSessionId: string | null = conversation?.sdkSessionId ?? null;

    this.bus.publish("task.started", { conversationId, prompt }, taskId);
    this.bus.publish("agent.status", { status: "working" }, taskId);
    const sdkContext: SdkToolContext = { taskId, signal: abort.signal };
    const mcpServer = createAtelierMcpServer(this.tools, () => sdkContext);

    try {
      const stream = query({
        prompt,
        options: {
          cwd: this.config.workspaceRoot,
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append:
              "STRICT WORKSPACE CONFINEMENT: You may only read, create, " +
              "modify, search, and run commands INSIDE the current workspace " +
              "directory. Never reference absolute paths, parent directories " +
              "(..), the user's home directory, or environment path variables " +
              "that point outside the workspace. All file paths must be " +
              "workspace-relative. Requests to work outside the workspace " +
              "must be declined with a short explanation.",
          },
          permissionMode: opts.planMode ? "plan" : "bypassPermissions",
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.effort ? { effort: opts.effort } : {}),
          disallowedTools: DISABLED_BUILTINS,
          mcpServers: { [MCP_SERVER_NAME]: mcpServer },
          // Only Atelier's own MCP server — never the user's global MCP config.
          strictMcpConfig: true,
          allowedTools: [`mcp__${MCP_SERVER_NAME}__*`],
          includePartialMessages: true,
          settingSources: [],
          abortController: abort,
          ...(sdkSessionId ? { resume: sdkSessionId } : {}),
        },
      });

      for await (const message of stream) {
        const m = message as Record<string, unknown>;

        if (m.type === "system" && m.subtype === "init") {
          const sid = m.session_id as string | undefined;
          if (sid && sid !== sdkSessionId) {
            sdkSessionId = sid;
            this.conversations.setSdkSessionId(conversationId, sid);
          }
        }

        if (m.type === "stream_event") {
          const event = m.event as {
            type?: string;
            delta?: { type?: string; text?: string; thinking?: string };
          };
          if (event?.type === "content_block_delta" && event.delta) {
            if (event.delta.type === "text_delta" && event.delta.text) {
              assistantText += event.delta.text;
              this.bus.publish(
                "chat.message.delta",
                { conversationId, messageId, delta: event.delta.text },
                taskId
              );
            } else if (
              event.delta.type === "thinking_delta" &&
              event.delta.thinking
            ) {
              this.bus.publish(
                "agent.thinking.delta",
                { conversationId, delta: event.delta.thinking },
                taskId
              );
            }
          }
        }

        if (m.type === "result") {
          const resultText = m.result as string | undefined;
          if (!assistantText && resultText) assistantText = resultText;
        }
      }

      this.finishTask(taskId, conversationId, messageId, assistantText, {
        status: "completed",
        startedAt,
      });
    } catch (error) {
      if (abort.signal.aborted) {
        this.finishTask(taskId, conversationId, messageId, assistantText, {
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
      this.log.error({ err: error, taskId }, "task failed");
      this.bus.publish(
        "task.error",
        { conversationId, message: String(error) },
        taskId
      );
      this.conversations.updateTaskStatus(taskId, "error", Date.now());
      this.running.delete(taskId);
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
