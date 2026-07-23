import { newId } from "@atelier/shared";
import type { EventBus } from "../events/event-bus.js";

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

  constructor(private bus: EventBus) {}

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
