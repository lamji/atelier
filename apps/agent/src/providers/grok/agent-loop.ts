import type { ImageAttachment } from "@atelier/protocol";
import type { ToolRegistry } from "../../tools/registry.js";
import type { EditFileReader } from "../ollama/edit-repair.js";
import { atelierToolsFor, runCall } from "../ollama/agent-loop.js";
import {
  grokApiKey,
  grokHost,
  grokHttpError,
  normalizeEffort,
  userContent,
} from "./client.js";
import { recordGrokUsage } from "./usage.js";

const IDLE_TIMEOUT_MS = 120_000;
const MAX_TURNS = 30;

interface GrokFunctionCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type GrokMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Array<Record<string, unknown>> }
  | { role: "assistant"; content: string | null; tool_calls?: GrokFunctionCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export interface GrokAgentLoopOptions {
  model: string;
  system: string;
  prompt: string;
  images?: ImageAttachment[];
  tools: ToolRegistry;
  files: EditFileReader;
  toolNames?: string[];
  effort?: string;
  taskId: string;
  signal: AbortSignal;
  emitText: (delta: string) => void;
  emitThinking?: (delta: string) => void;
}

/** Full Atelier agent loop over xAI's streaming Chat Completions API. */
export async function runGrokAgentLoop(
  opts: GrokAgentLoopOptions
): Promise<string> {
  const messages: GrokMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: userContent(opts.prompt, opts.images) },
  ];
  const tools = atelierToolsFor(opts.toolNames);
  let text = "";

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const message = await streamRound(opts, messages, tools, (delta) => {
      text += delta;
      opts.emitText(delta);
    });
    messages.push(message);
    const calls = message.tool_calls ?? [];
    if (calls.length === 0) return text;

    // Keep mutation ordering identical to Ollama. ToolRegistry owns hooks,
    // telemetry, diffs, cancellation and approval for every call.
    for (const call of calls) {
      const input = parseArguments(call.function.arguments);
      const result = await runCall(call.function.name, input, opts);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  throw new Error(`Grok agent loop exceeded ${MAX_TURNS} turns`);
}

async function streamRound(
  opts: GrokAgentLoopOptions,
  messages: GrokMessage[],
  tools: Array<Record<string, unknown>>,
  onDelta: (delta: string) => void
): Promise<Extract<GrokMessage, { role: "assistant" }>> {
  const key = grokApiKey();
  if (!key) throw new Error("Grok API key is not configured");
  const abort = new AbortController();
  const onOuterAbort = () => abort.abort();
  opts.signal.addEventListener("abort", onOuterAbort, { once: true });
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abort.abort(), IDLE_TIMEOUT_MS);
  };
  const started = Date.now();

  try {
    armIdle();
    const response = await fetch(`${grokHost()}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "x-grok-conv-id": opts.taskId,
      },
      body: JSON.stringify({
        model: opts.model,
        messages,
        tools,
        tool_choice: "auto",
        stream: true,
        stream_options: { include_usage: true },
        ...(opts.effort
          ? { reasoning_effort: normalizeEffort(opts.effort) }
          : {}),
      }),
      signal: abort.signal,
    });
    if (!response.ok) throw await grokHttpError(response, `run model "${opts.model}"`);
    if (!response.body) throw new Error("Grok returned no response body");

    let content = "";
    const calls = new Map<number, GrokFunctionCall>();
    let inputTokens = 0;
    let outputTokens = 0;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const handleEvent = (event: string): void => {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (!data || data === "[DONE]") return;
      const chunk = JSON.parse(data) as {
        choices?: Array<{
          delta?: {
            content?: string;
            reasoning_content?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        content += delta.content;
        onDelta(delta.content);
      }
      if (delta?.reasoning_content) opts.emitThinking?.(delta.reasoning_content);
      for (const part of delta?.tool_calls ?? []) {
        const index = part.index ?? 0;
        const current = calls.get(index) ?? {
          id: "",
          type: "function" as const,
          function: { name: "", arguments: "" },
        };
        current.id += part.id ?? "";
        current.function.name += part.function?.name ?? "";
        current.function.arguments += part.function?.arguments ?? "";
        calls.set(index, current);
      }
      inputTokens = chunk.usage?.prompt_tokens ?? inputTokens;
      outputTokens = chunk.usage?.completion_tokens ?? outputTokens;
    };

    for (;;) {
      const { done, value } = await reader.read();
      armIdle();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) handleEvent(event);
    }
    if (buffer.trim()) handleEvent(buffer);
    recordGrokUsage({ inputTokens, outputTokens, durationMs: Date.now() - started });

    const toolCalls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call)
      .filter((call) => call.id && call.function.name);
    return {
      role: "assistant",
      content: content || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
  } catch (error) {
    if (!opts.signal.aborted && abort.signal.aborted) {
      throw new Error(
        `Grok stream for "${opts.model}" stalled — no data for ${IDLE_TIMEOUT_MS / 1000}s`
      );
    }
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    opts.signal.removeEventListener("abort", onOuterAbort);
  }
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value || "{}") as unknown;
  } catch {
    return {};
  }
}
