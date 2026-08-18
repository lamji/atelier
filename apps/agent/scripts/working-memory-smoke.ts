/**
 * Proves the three pieces of "the AI remembers what it looked at, and you
 * can see what it was sent":
 *
 *  1. WorkingMemoryStore records reads/searches from tool results and
 *     recalls them for a LATER task — unchanged files inlined, changed ones
 *     flagged, older ones listed, searches replayed as query → hits.
 *  2. buildLlmRequest / llmRequestSummary / llmRequestDetail describe a
 *     request block by block, and flag overflow against a window.
 *  3. The Ollama loop reports every round through onRequest, accepts
 *     pre-grounded paths for its blind-edit guard, and elides old tool
 *     results (fitToWindow) instead of letting the window overflow.
 *
 * Runs under the Electron binary (better-sqlite3 ABI) — see
 * scripts/context-smoke.ts for the invocation.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { llmRequestDetail, llmRequestSummary } from "@atelier/shared";
import { openDb } from "../src/storage/db.js";
import {
  WorkingMemoryStore,
  pathsInResult,
} from "../src/context/working-memory/index.js";
import { buildLlmRequest } from "../src/orchestrator/llm-request.js";
import {
  fitToWindow,
  runOllamaAgentLoop,
  type OllamaRequestInfo,
} from "../src/providers/ollama/agent-loop.js";
import { EventBus } from "../src/events/event-bus.js";
import { ToolRegistry } from "../src/tools/registry.js";

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`${ok ? "ok" : "FAIL"} ${label}`);
  if (!ok) failures += 1;
}

async function workingMemory(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-wm-"));
  const db = openDb(dir);
  db.prepare(
    "INSERT INTO conversations(id, title, sdk_session_id, created_at, updated_at) " +
      "VALUES('c1', 't', NULL, 1, 1)"
  ).run();
  const store = new WorkingMemoryStore(db);
  const disk = new Map<string, string>([
    ["src/a.ts", "export const a = 1;\n".repeat(20)],
    ["src/b.ts", "export const b = 2;\n"],
    ["src/old.ts", "old\n"],
  ]);
  const files = {
    readFile: async (rel: string, opts: { offset?: number; limit?: number } = {}) => {
      const content = disk.get(rel);
      if (content === undefined) throw new Error(`ENOENT ${rel}`);
      if (opts.offset === undefined && opts.limit === undefined) return { content };
      const lines = content.split(/(?<=\n)/);
      const start = Math.max(0, (opts.offset ?? 1) - 1);
      const end = opts.limit === undefined ? lines.length : start + opts.limit;
      return { content: lines.slice(start, end).join(""), totalLines: lines.length };
    },
  };

  // Task 1 (older): read old.ts. Task 2 (newer): read a.ts (range), b.ts, search.
  store.noteTool({
    conversationId: "c1",
    taskId: "t1",
    name: "read_file",
    input: { path: "src/old.ts" },
    result: { content: "old\n" },
  });
  // Push t1 into "older than the inline depth" by adding tasks in between.
  for (const taskId of ["t1b", "t1c"]) {
    store.noteTool({
      conversationId: "c1",
      taskId,
      name: "search_text",
      input: { query: `q-${taskId}` },
      result: { matches: [{ path: "src/a.ts" }] },
    });
  }
  store.noteTool({
    conversationId: "c1",
    taskId: "t2",
    name: "read_file",
    input: { path: "src/a.ts", offset: 1, limit: 5 },
    result: { content: (await files.readFile("src/a.ts", { offset: 1, limit: 5 })).content },
  });
  store.noteTool({
    conversationId: "c1",
    taskId: "t2",
    name: "read_many_files",
    input: { files: [{ path: "src/b.ts" }] },
    result: [{ path: "src/b.ts", content: "export const b = 2;\n" }],
  });
  store.noteTool({
    conversationId: "c1",
    taskId: "t2",
    name: "search_workspace",
    input: { query: "where is b" },
    result: { matches: [{ path: "src/b.ts", score: 1 }, { path: "src/a.ts" }] },
  });
  // b.ts changes on disk after it was read.
  disk.set("src/b.ts", "export const b = 3;\n");

  const recalled = await store.recall({
    conversationId: "c1",
    currentTaskId: "t3",
    files,
    maxTokens: 2000,
  });
  check(recalled.inlined === 2, `two recent reads inlined (got ${recalled.inlined})`);
  check(recalled.changed === 1, `changed file detected (got ${recalled.changed})`);
  check(recalled.listed === 1, `older read listed by path only (got ${recalled.listed})`);
  check(recalled.searches === 3, `searches replayed (got ${recalled.searches})`);
  check(
    recalled.text.includes("--- src/a.ts (lines 1-5) ---") &&
      recalled.text.includes("export const a = 1;"),
    "recalled block inlines the exact read range"
  );
  check(
    recalled.text.includes("src/b.ts — CHANGED since it was read"),
    "recalled block flags the changed file"
  );
  check(
    recalled.text.includes('search_workspace "where is b" → src/b.ts, src/a.ts'),
    "recalled block replays search hits"
  );
  check(
    recalled.groundedPaths.includes("src/a.ts") &&
      recalled.groundedPaths.includes("src/b.ts") &&
      !recalled.groundedPaths.includes("src/old.ts"),
    "grounded paths are exactly the fully inlined files"
  );

  // The current task's own reads are never replayed to itself.
  const self = await store.recall({
    conversationId: "c1",
    currentTaskId: "t2",
    files,
    maxTokens: 2000,
  });
  check(
    self.inlined + self.listed === 1 &&
      !self.text.includes("src/a.ts (lines") &&
      !self.text.includes("src/b.ts"),
    "a task's own reads are excluded"
  );

  // A tight budget lists instead of inlining.
  const tight = await store.recall({
    conversationId: "c1",
    currentTaskId: "t3",
    files,
    maxTokens: 100,
  });
  check(tight.inlined === 0 && tight.listed === 3, "tight budget falls back to paths");

  // Wiki-named owner files ride in after the conversation's own reads and
  // count as grounded; a fresh conversation with nothing read still gets them.
  const seeded = await store.recall({
    conversationId: "c-empty",
    currentTaskId: "t9",
    files,
    maxTokens: 2000,
    seedPaths: ["src/old.ts", "src/nope.ts"],
  });
  check(
    seeded.seeded === 1 &&
      seeded.groundedPaths.includes("src/old.ts") &&
      seeded.text.includes("Owner files named by the matched feature-wiki page") &&
      seeded.text.includes("--- src/old.ts ---"),
    "wiki seed paths are inlined and grounded, missing ones skipped"
  );
  const seededAndRead = await store.recall({
    conversationId: "c1",
    currentTaskId: "t3",
    files,
    maxTokens: 4000,
    seedPaths: ["src/a.ts", "src/old.ts"],
  });
  check(
    seededAndRead.seeded === 0,
    "seed paths already covered by the conversation's reads are not doubled"
  );

  check(
    pathsInResult({ a: [{ path: "x" }, { nested: { path: "y" } }], path: "z" })
      .sort()
      .join(",") === "x,y,z",
    "pathsInResult walks nested results"
  );
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

function llmRequestText(): void {
  const request = buildLlmRequest({
    purpose: "execute",
    provider: "ollama",
    model: "qwen",
    sections: [
      { name: "rules", text: "R".repeat(4000) },
      { name: "empty", text: "" },
      { name: "knowledge context", text: "K".repeat(2000) },
    ],
    prompt: "fix it",
    toolsOffered: 12,
    contextWindow: 1000,
  });
  check(request.sections.length === 2, "empty sections are dropped");
  check(request.systemTokens === 1500 && request.promptTokens === 2, "token estimates");
  check(request.overflow, "overflow flagged against a small window");
  const summary = llmRequestSummary(request);
  check(
    summary.startsWith("Sent to model (ollama · qwen · execute): ~1.5k tok") &&
      summary.includes("rules 1.0k") &&
      summary.includes("12 tool(s)") &&
      summary.includes("exceeds the context window"),
    `summary line reads right: ${summary}`
  );
  const detail = llmRequestDetail(request);
  check(
    detail.includes("═══ rules (~1.0k tok) ═══") &&
      detail.includes("R".repeat(4000)) &&
      detail.includes("═══ user prompt") &&
      detail.includes("fix it"),
    "detail carries every section verbatim and the prompt"
  );
  const round = buildLlmRequest({
    purpose: "execute",
    provider: "ollama",
    model: "qwen",
    round: 3,
    transcript: [{ role: "tool", chars: 4000, label: "read_file" }],
    transcriptChars: 4000,
    contextWindow: 32000,
    elided: 2,
  });
  const roundSummary = llmRequestSummary(round);
  check(
    roundSummary.startsWith("Tool round 3 sent to model") &&
      roundSummary.includes("2 old tool result(s) elided"),
    `tool round summary: ${roundSummary}`
  );
}

async function ollamaLoop(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let round = 0;
  const seenBodies: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (!body.messages) {
      return Response.json({
        model_info: { "smoke.context_length": 1200 },
        capabilities: ["tools"],
      });
    }
    seenBodies.push(body);
    round += 1;
    const reply = (message: Record<string, unknown>) =>
      new Response(`${JSON.stringify({ message, done: true })}\n`, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    // Rounds 1-6: read a big file each time; then edit the pre-grounded
    // file WITHOUT reading it; then finish.
    if (round <= 6) {
      return reply({
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "read_file", arguments: { path: `f${round}.ts` } } }],
      });
    }
    if (round === 7) {
      return reply({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            function: {
              name: "replace_code",
              arguments: { path: "src/pre.ts", oldString: "a", newString: "b" },
            },
          },
        ],
      });
    }
    return reply({ role: "assistant", content: "done" });
  };
  try {
    const tools = new ToolRegistry(new EventBus());
    tools.register("read_file", async () => ({ content: "x".repeat(2000) }));
    let editRan = false;
    tools.register("replace_code", async () => {
      editRan = true;
      return { ok: true };
    });
    const requests: OllamaRequestInfo[] = [];
    const text = await runOllamaAgentLoop({
      model: "smoke",
      target: "ollama-local",
      system: "rules",
      prompt: "go",
      tools,
      files: { readFile: async () => ({ content: "a" }) },
      preGrounded: ["src/pre.ts"],
      taskId: "t-ollama",
      signal: new AbortController().signal,
      emitText: () => undefined,
      onRequest: (info) => requests.push(info),
    });
    check(text === "done", `loop finished (${text})`);
    check(editRan, "pre-grounded path allowed the edit without a read this turn");
    check(requests.length === 8, `onRequest fired per round (${requests.length})`);
    check(
      requests[0]!.round === 0 &&
        requests[0]!.contextWindow === 1200 &&
        requests[0]!.transcript.length === 2,
      "round 0 reports window and the opening transcript"
    );
    const last = requests[requests.length - 1]!;
    check(last.elided > 0, `old tool results were elided to fit (${last.elided})`);
    const lastBody = seenBodies[seenBodies.length - 1]!;
    const toolBodies = lastBody.messages.filter((m) => m.role === "tool");
    check(
      toolBodies.some((m) => m.content?.startsWith("[elided")) &&
        toolBodies.slice(-2).every((m) => !m.content?.startsWith("[elided")),
      "oldest results elided, newest kept intact"
    );
    check(
      lastBody.messages[0]!.role === "system" &&
        lastBody.messages[0]!.content === "rules",
      "system prompt untouched by eliding"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  // fitToWindow in isolation: nothing to do under the limit.
  const small = [
    { role: "system" as const, content: "s" },
    { role: "user" as const, content: "u" },
    { role: "tool" as const, tool_name: "read_file", content: "r".repeat(500) },
  ];
  check(fitToWindow(small, 32000, 10) === 0, "fitToWindow is a no-op under the limit");
}

async function main(): Promise<void> {
  await workingMemory();
  llmRequestText();
  await ollamaLoop();
  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("working-memory smoke passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
