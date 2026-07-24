import { newId } from "@atelier/shared";
import type { EventBus } from "../events/event-bus.js";

/** Hook gate contract (implemented by HooksEngine). */
export interface ToolGate {
  evaluateToolUse(
    toolName: string,
    input: unknown,
    taskId: string,
    /** Lets a hook that waits on the user give up when the task stops. */
    signal?: AbortSignal
  ): Promise<{ allowed: boolean; reason?: string }>;
}

export interface ToolContext {
  taskId: string;
  signal: AbortSignal;
  emitOutput: (chunk: string) => void;
}

export type ToolImpl<I = unknown, O = unknown> = (
  input: I,
  ctx: ToolContext
) => Promise<O>;

/**
 * Single registry of tool implementations. Consumed by the bridge RPC router
 * (UI-invoked) and by orchestrator/sdk-tools.ts (model-invoked). Both paths
 * emit identical tool.* events, so nothing bypasses observability.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolImpl>();
  private gate: ToolGate | null = null;

  constructor(private bus: EventBus) {}

  /** Installed once at startup; every run() then flows through hooks. */
  setGate(gate: ToolGate): void {
    this.gate = gate;
  }

  register<I, O>(name: string, impl: ToolImpl<I, O>): void {
    if (this.tools.has(name)) throw new Error(`Tool already registered: ${name}`);
    this.tools.set(name, impl as ToolImpl);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  async run<O = unknown>(
    name: string,
    input: unknown,
    taskId: string,
    signal: AbortSignal
  ): Promise<O> {
    const impl = this.tools.get(name);
    if (!impl) throw new Error(`Unknown tool: ${name}`);
    const toolCallId = newId("tc");
    const startedAt = Date.now();
    this.bus.publish("tool.started", { toolCallId, name, input }, taskId);
    if (this.gate) {
      const decision = await this.gate.evaluateToolUse(
        name,
        input,
        taskId,
        signal
      );
      if (!decision.allowed) {
        const error = `Blocked by hook: ${decision.reason ?? "no reason given"}`;
        this.bus.publish(
          "tool.failed",
          { toolCallId, name, error, durationMs: Date.now() - startedAt },
          taskId
        );
        throw new Error(error);
      }
    }
    const ctx: ToolContext = {
      taskId,
      signal,
      emitOutput: (chunk) =>
        this.bus.publish("tool.output", { toolCallId, chunk }, taskId),
    };
    try {
      const result = await impl(input, ctx);
      this.bus.publish(
        "tool.completed",
        { toolCallId, name, result, durationMs: Date.now() - startedAt },
        taskId
      );
      return result as O;
    } catch (error) {
      this.bus.publish(
        "tool.failed",
        {
          toolCallId,
          name,
          error: String(error),
          durationMs: Date.now() - startedAt,
        },
        taskId
      );
      throw error;
    }
  }
}
