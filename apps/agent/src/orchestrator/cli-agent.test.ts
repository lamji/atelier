import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EventBus } from "../events/event-bus.js";
import { ToolRegistry } from "../tools/registry.js";
import { registerFsTools } from "../tools/fs-tools.js";
import { FileService } from "../workspace/file-service.js";
import { PathGuard } from "../workspace/path-guard.js";
import { WorkspaceIgnore } from "../workspace/ignore.js";
import { SearchGroundingGuard } from "../hooks/search-grounding-guard.js";
import type { HookGuardContext } from "../hooks/hooks-engine.js";
import { shapeToolOutput } from "../context/tool-output/index.js";
import { runGrokAgentLoop } from "../providers/grok/agent-loop.js";
import { runOllamaAgentLoop, runCall } from "../providers/ollama/agent-loop.js";
import { DIRECT_TOOLS } from "./direct-mode.js";
import { createAtelierMcpServer } from "./sdk-tools.js";
import { TurnRunner, type TurnRunnerDeps } from "./turn-runner.js";
import type { TaskContext } from "./pipeline-executor.js";

test("turn context uses current chat messages without a shared-session service", async () => {
  const bus = new EventBus();
  const events: string[] = [];
  bus.subscribe((event) => events.push(event.topic));
  const runner = new TurnRunner({
    bus,
    skillLoader: { load: () => ({ skills: [], context: "" }) },
  } as unknown as TurnRunnerDeps);
  const ctx = {
    opts: { model: "claude-sonnet-4-6" },
    humanPrompt: "continue", priorTurns: [
      { role: "user", text: "Fix the login button" },
      { role: "assistant", text: "The handler is in LoginPanel.tsx" },
    ],
    imagePaths: [], images: [], recoveryPlan: "",
  } as unknown as TaskContext;
  const context = await runner.context(ctx);
  assert.match(context, /CONVERSATION SO FAR/);
  assert.match(context, /LoginPanel.tsx/);
  assert.doesNotMatch(context, /ALIGNED ATELIER|Earlier work|compressed/);
  assert(!events.includes("session.recalled"));
  ctx.opts.model = "ollama/offline-test";
  assert.equal(await runner.context(ctx), "", "Ollama carries its own chat messages");
});

test("workspace search reads current text without knowledge services", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-cli-search-"));
  try {
    await fs.writeFile(path.join(root, "source.ts"), "export const actualHandler = 1;\n");
    await fs.writeFile(path.join(root, ".gitignore"), "hidden.ts\n");
    await fs.writeFile(path.join(root, "hidden.ts"), "actualHandler");
    const bus = new EventBus();
    const tools = new ToolRegistry(bus);
    const files = new FileService(new PathGuard(root), new WorkspaceIgnore(root), bus);
    registerFsTools(tools, files);
    const signal = new AbortController().signal;
    const search = (name: string, query: string) => tools.run<{ matches: Array<{ path: string }> }>(
      name, { query, glob: "*.ts" }, "task", signal
    );
    assert.deepEqual((await search("search_workspace", "actualHandler")).matches.map((m) => m.path), ["source.ts"]);
    await fs.writeFile(path.join(root, "source.ts"), "export const replacementHandler = 2;\n");
    assert.equal((await search("search_workspace", "actualHandler")).matches.length, 0);
    assert.deepEqual(await search("search_workspace", "replacementHandler"), await search("search_text", "replacementHandler"));
    assert.match(shapeToolOutput("search_workspace", { matches: [], scanned: 2, note: "partial search" }), /partial search/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Claude MCP lists only CLI tools and cannot invoke knowledge tools", async () => {
  const tools = new ToolRegistry(new EventBus());
  let knowledgeCalls = 0;
  tools.register("retrieve_knowledge", async () => { knowledgeCalls++; return {}; });
  const config = createAtelierMcpServer(tools, () => ({ taskId: "task", signal: new AbortController().signal }), undefined, DIRECT_TOOLS);
  const client = new Client({ name: "cli-agent-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await config.instance.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const offered = (await client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(new Set(offered), new Set([...DIRECT_TOOLS, "view_image"]));
    const result = await client.callTool({ name: "retrieve_knowledge", arguments: { query: "anything" } });
    assert.equal(result.isError, true);
    assert.equal(knowledgeCalls, 0);
    const rejected = await runCall("retrieve_knowledge", {}, {
      tools, files: { readFile: async () => ({ content: "" }) }, taskId: "task",
      signal: new AbortController().signal, toolNames: DIRECT_TOOLS,
    });
    assert.match(rejected, /unavailable/);
    assert.equal(knowledgeCalls, 0);
  } finally {
    await client.close();
    await config.instance.close();
  }
});

test("searches follow observed context, including regex and later reads", async () => {
  const guard = new SearchGroundingGuard(new EventBus());
  guard.seed("task", ["fix login", "src/LoginPanel.tsx"]);
  const check = (query: string, regex = false, taskId = "task") => guard.check({
    taskId, toolName: "search_text", input: { query, regex },
  } as HookGuardContext);
  assert.equal(await check("LoginPanel"), undefined);
  assert.equal((await check("guessedLoginHandler"))?.allowed, false);
  assert.equal((await check("guessedLoginHandler"))?.allowed, false);
  guard.note("task", "function observedLoginHandler() {}\n登录");
  assert.equal(await check("\\bobservedLoginHandler\\b", true), undefined);
  assert.equal(await check("登录"), undefined);
  assert.equal((await check("登陆"))?.allowed, false);
  guard.seed("other-task", ["fix login"]);
  assert.equal((await check("observedLoginHandler", false, "other-task"))?.allowed, false);
});

test("Grok finishes beyond 40 rounds; Grok and Ollama still obey Stop", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = "offline-test";
  let rounds = 0;
  let runs = 0;
  let cancel = false;
  let controller = new AbortController();
  const tools = new ToolRegistry(new EventBus());
  tools.register("list_dir", async () => {
    runs++;
    if (cancel) controller.abort();
    return { entries: ["source.ts"] };
  });
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (!body.messages) return Response.json({ model_info: { "test.context_length": 8192 }, capabilities: ["tools"] });
    rounds++;
    const names = body.tools.map((entry: { function: { name: string } }) => entry.function.name);
    assert(names.includes("list_dir"));
    assert(!names.includes("retrieve_knowledge"));
    const done = !cancel && rounds > 45;
    if (String(url).includes("/api/chat")) {
      return new Response(JSON.stringify({ message: { role: "assistant", content: "", tool_calls: [
        { function: { name: "list_dir", arguments: {} } },
      ] }, done: true }) + "\n");
    }
    const delta = done ? { content: "finished" } : { tool_calls: [
      { index: 0, id: `call-${rounds}`, function: { name: "list_dir", arguments: "{}" } },
    ] };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
  };
  const options = () => ({
    model: "offline-cli-test", system: "test", prompt: "test", tools,
    toolNames: DIRECT_TOOLS, files: { readFile: async () => ({ content: "" }) },
    taskId: "task", signal: controller.signal, emitText: () => {},
  });
  try {
    assert.equal(await runGrokAgentLoop(options()), "finished");
    assert.equal(rounds, 46);
    assert.equal(runs, 45);
    cancel = true;
    rounds = 0;
    await assert.rejects(runGrokAgentLoop(options()), { name: "AbortError" });
    assert.equal(rounds, 1);
    controller = new AbortController();
    rounds = 0;
    await assert.rejects(runOllamaAgentLoop({ ...options(), target: "ollama-local" }), { name: "AbortError" });
    assert.equal(rounds, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = originalKey;
  }
});
