import { EventBus } from "../src/events/event-bus.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { runGrokAgentLoop } from "../src/providers/grok/agent-loop.js";
import { listGrokModels } from "../src/providers/grok/client.js";
import { grokModelName, isGrokModel } from "../src/providers/model-routing.js";

process.env.XAI_API_KEY = "smoke-key";
process.env.XAI_API_HOST = "https://smoke.invalid/v1";

const requests: Array<Record<string, unknown>> = [];
let round = 0;
globalThis.fetch = async (_input, init) => {
  if (String(_input).endsWith("/language-models")) {
    return Response.json({
      models: [
        {
          id: "grok-smoke",
          input_modalities: ["text", "image"],
          output_modalities: ["text"],
          context_length: 131072,
        },
      ],
    });
  }
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  requests.push(body);
  round += 1;
  const chunks =
    round === 1
      ? [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      function: {
                        name: "search_workspace",
                        arguments: '{"query":"Grok smoke"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ]
      : [
          { choices: [{ delta: { reasoning_content: "checked" } }] },
          { choices: [{ delta: { content: "OK" } }] },
          {
            choices: [],
            usage: { prompt_tokens: 12, completion_tokens: 2 },
          },
        ];
  const sse = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(sse, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
};

const bus = new EventBus();
const toolNames: string[] = [];
bus.subscribe((event) => {
  if (event.topic === "tool.started") {
    toolNames.push(String((event.payload as { name?: string }).name ?? ""));
  }
});
const tools = new ToolRegistry(bus);
tools.register("search_workspace", async () => ({
  matches: [{ path: "README.md", row: 1, preview: "Grok smoke" }],
  strategy: "smoke",
}));

let streamed = "";
let thinking = "";
const catalog = await listGrokModels();
if (catalog[0]?.id !== "grok-smoke" || !catalog[0].inputModalities.includes("image")) {
  throw new Error("Grok language-model discovery failed");
}
const text = await runGrokAgentLoop({
  model: "grok-smoke",
  system: "Use Atelier tools.",
  prompt: "Run the Grok smoke.",
  images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
  tools,
  files: {} as never,
  taskId: "task_grok_smoke",
  signal: new AbortController().signal,
  emitText: (delta) => (streamed += delta),
  emitThinking: (delta) => (thinking += delta),
});

const secondMessages = requests[1]?.messages as Array<Record<string, unknown>>;
const firstMessages = requests[0]?.messages as Array<Record<string, unknown>>;
const user = firstMessages?.find((message) => message.role === "user");
if (!JSON.stringify(user?.content).includes("data:image/png;base64,aW1hZ2U=")) {
  throw new Error("Grok image input was not forwarded");
}
if (!isGrokModel("grok/grok-smoke") || grokModelName("grok/grok-smoke") !== "grok-smoke") {
  throw new Error("Grok model routing failed");
}
if (text !== "OK" || streamed !== "OK") throw new Error("Grok text did not stream");
if (thinking !== "checked") throw new Error("Grok reasoning did not stream");
if (!toolNames.includes("search_workspace")) throw new Error("Atelier tool did not run");
if (!secondMessages?.some((message) => message.role === "tool" && message.tool_call_id === "call_1")) {
  throw new Error("Grok tool result was not returned with its call id");
}
console.log(
  "Grok agent smoke passed: catalog, tools, tool results, reasoning, and text streaming"
);
