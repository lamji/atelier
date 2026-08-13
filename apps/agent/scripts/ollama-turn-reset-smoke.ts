/**
 * Proves that Ollama's tool budget is per prompt and that exhausting it
 * produces a tool-free final response instead of a task error.
 */
import { EventBus } from "../src/events/event-bus.js";
import { runOllamaAgentLoop } from "../src/providers/ollama/agent-loop.js";
import { ToolRegistry } from "../src/tools/registry.js";

const originalFetch = globalThis.fetch;
const chatRounds = new Map<string, number>();
let toolRuns = 0;

function stream(message: Record<string, unknown>): Response {
  return new Response(`${JSON.stringify({ message, done: true })}\n`, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

globalThis.fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as {
    model?: string;
    messages?: Array<{ role?: string; content?: string }>;
    tools?: unknown[];
  };
  if (!body.messages) {
    return Response.json({
      model_info: { "smoke.context_length": 8192 },
      capabilities: ["tools"],
    });
  }

  const prompt = body.messages.find((message) => message.role === "user")?.content ?? "";
  const round = (chatRounds.get(prompt) ?? 0) + 1;
  chatRounds.set(prompt, round);
  if ((body.tools?.length ?? 0) === 0) {
    return stream({ role: "assistant", content: `finished:${prompt}` });
  }
  return stream({
    role: "assistant",
    content: "",
    tool_calls: [
      { function: { name: "read_file", arguments: { path: "smoke.txt" } } },
    ],
  });
};

async function run(prompt: string, tools: ToolRegistry): Promise<string> {
  return runOllamaAgentLoop({
    model: "turn-reset-smoke",
    target: "ollama-local",
    system: "smoke",
    prompt,
    tools,
    files: { readFile: async () => ({ content: "smoke" }) },
    taskId: `task-${prompt}`,
    signal: new AbortController().signal,
    emitText: () => undefined,
  });
}

async function main(): Promise<void> {
  try {
    const tools = new ToolRegistry(new EventBus());
    tools.register("read_file", async () => {
      toolRuns += 1;
      return { content: "smoke" };
    });

    const first = await run("first", tools);
    const followUp = await run("follow-up", tools);
    const ok =
      first === "finished:first" &&
      followUp === "finished:follow-up" &&
      chatRounds.get("first") === 31 &&
      chatRounds.get("follow-up") === 31 &&
      toolRuns === 60;
    console.log(
      `${ok ? "ok" : "FAIL"} Ollama follow-up starts with a fresh 30-round tool budget`
    );
    if (!ok) {
      console.log({ first, followUp, rounds: Object.fromEntries(chatRounds), toolRuns });
      process.exitCode = 1;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void main();
