/**
 * Proves that Ollama's tool budget is per prompt and that its completion
 * boundary refuses a premature report until the live work is finished.
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
  if (prompt === "completion-gate") {
    if (round === 1) {
      return stream({ role: "assistant", content: "premature report" });
    }
    if (round === 2) {
      return stream({ role: "assistant", content: "premature report retry" });
    }
    if (round === 3) {
      return stream({
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "read_file", arguments: { path: "smoke.txt" } } },
        ],
      });
    }
    return stream({ role: "assistant", content: "finished:completion-gate" });
  }
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

async function run(
  prompt: string,
  tools: ToolRegistry,
  hooks: {
    completionGate?: () => string;
    onCompletionBlocked?: (reason: string) => void;
    emitText?: (delta: string) => void;
  } = {}
): Promise<string> {
  return runOllamaAgentLoop({
    model: "turn-reset-smoke",
    target: "ollama-local",
    system: "smoke",
    prompt,
    tools,
    files: { readFile: async () => ({ content: "smoke" }) },
    taskId: `task-${prompt}`,
    signal: new AbortController().signal,
    emitText: hooks.emitText ?? (() => undefined),
    ...(hooks.completionGate
      ? { completionGate: hooks.completionGate }
      : {}),
    ...(hooks.onCompletionBlocked
      ? { onCompletionBlocked: hooks.onCompletionBlocked }
      : {}),
  });
}

async function main(): Promise<void> {
  try {
    const tools = new ToolRegistry(new EventBus());
    let gateOpen = true;
    let gateWorkRuns = 0;
    tools.register("read_file", async (_input, ctx) => {
      toolRuns += 1;
      if (ctx.taskId === "task-completion-gate") {
        gateWorkRuns += 1;
        gateOpen = false;
      }
      return { content: "smoke" };
    });

    const gateOnly = process.argv.includes("--gate-only");
    let first = "";
    let followUp = "";
    let resetOk = true;
    if (!gateOnly) {
      first = await run("first", tools);
      followUp = await run("follow-up", tools);
      resetOk =
        first === "finished:first" &&
        followUp === "finished:follow-up" &&
        chatRounds.get("first") === 31 &&
        chatRounds.get("follow-up") === 31;
      console.log(
        `${resetOk ? "ok" : "FAIL"} Ollama follow-up starts with a fresh 30-round tool budget`
      );
    }

    const emitted: string[] = [];
    const blocked: string[] = [];
    const gated = await run("completion-gate", tools, {
      completionGate: () => (gateOpen ? "finish the remaining plan step" : ""),
      onCompletionBlocked: (reason) => blocked.push(reason),
      emitText: (delta) => emitted.push(delta),
    });
    const gateOk =
      gated === "finished:completion-gate" &&
      emitted.join("") === "finished:completion-gate" &&
      !emitted.join("").includes("premature report") &&
      blocked.length === 2 &&
      blocked.every((reason) => reason === "finish the remaining plan step") &&
      gateWorkRuns === 1 &&
      chatRounds.get("completion-gate") === 4;
    console.log(
      `${gateOk ? "ok" : "FAIL"} Ollama blocks repeated report retries and finishes the gated work in-session`
    );

    const readLoopOk = toolRuns === (gateOnly ? 1 : 3);
    console.log(
      `${readLoopOk ? "ok" : "FAIL"} Ollama executes one successful read per unchanged invocation`
    );

    if (!resetOk || !gateOk || !readLoopOk) {
      console.log({
        first,
        followUp,
        gated,
        emitted,
        blocked,
        gateWorkRuns,
        rounds: Object.fromEntries(chatRounds),
        toolRuns,
      });
      process.exitCode = 1;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void main();
