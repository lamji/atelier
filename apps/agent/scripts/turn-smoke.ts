/**
 * Live turn-latency smoke: boots the full runtime against a throwaway
 * sample workspace, sends real prompts through task.start, and prints a
 * per-stage wall-clock breakdown for each.
 *
 * This is the number the user feels — send → answer done — so it is the
 * one to watch after any pipeline change. Requires Claude auth (the SDK
 * uses the local Claude Code login), and the Electron ABI for
 * better-sqlite3:
 *
 *   ELECTRON_RUN_AS_NODE=1 <electron> <tsx-cli> scripts/turn-smoke.ts
 *   (or: pnpm --filter @atelier/agent smoke:turn on a matching node ABI)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { createAgentRuntime } from "../src/runtime.js";
import { resolveConfig } from "../src/config/agent-config.js";
import type { PublishedEvent } from "../src/events/event-bus.js";

const TURN_TIMEOUT_MS = 300_000;

/** A tiny express-ish sample app, so retrieval has something real to find. */
const SAMPLE_FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    { name: "sample-api", version: "1.0.0", main: "src/server.js" },
    null,
    2
  ),
  "src/server.js": [
    "const { createRouter } = require('./router');",
    "const http = require('http');",
    "",
    "const router = createRouter();",
    "router.get('/users', (req, res) => res.end('[]'));",
    "router.get('/users/:id', (req, res) => res.end('{}'));",
    "",
    "http.createServer(router.handle).listen(3000);",
    "",
  ].join("\n"),
  "src/router.js": [
    "// Minimal path router: exact segments, ':' params, first match wins.",
    "function createRouter() {",
    "  const routes = [];",
    "  const add = (method) => (pattern, handler) =>",
    "    routes.push({ method, pattern: pattern.split('/'), handler });",
    "  function handle(req, res) {",
    "    const segs = req.url.split('?')[0].split('/');",
    "    for (const route of routes) {",
    "      if (route.method !== req.method.toLowerCase()) continue;",
    "      if (route.pattern.length !== segs.length) continue;",
    "      const ok = route.pattern.every(",
    "        (p, i) => p.startsWith(':') || p === segs[i]",
    "      );",
    "      if (ok) return route.handler(req, res);",
    "    }",
    "    res.statusCode = 404;",
    "    res.end('not found');",
    "  }",
    "  return { get: add('get'), post: add('post'), handle };",
    "}",
    "module.exports = { createRouter };",
    "",
  ].join("\n"),
};

interface StageRow {
  stage: string;
  ms: number;
  ok: boolean;
  detail: string;
}

interface TurnTiming {
  prompt: string;
  totalMs: number;
  firstDeltaMs: number | null;
  answerDoneMs: number | null;
  stages: StageRow[];
  answerChars: number;
  /** Files the turn actually edited (edit.applied events). */
  editsApplied: string[];
  /** Steps in the plan the model published via set_plan, if it did. */
  planSteps: number | null;
  /** plan.step.updated events — the checklist visibly advancing. */
  planUpdates: number;
  /** tool.started events — the rail had rows to show. */
  toolCalls: number;
}

async function runTurn(
  runtime: ReturnType<typeof createAgentRuntime>,
  conversationId: string,
  prompt: string,
  model?: string
): Promise<TurnTiming> {
  const ctx = {
    connectionId: "smoke",
    authenticated: true,
    progress: () => undefined,
    signal: new AbortController().signal,
  };
  const stages: StageRow[] = [];
  let firstDeltaMs: number | null = null;
  let answerDoneMs: number | null = null;
  let answerChars = 0;
  const editsApplied: string[] = [];
  let planSteps: number | null = null;
  let planUpdates = 0;
  let toolCalls = 0;
  const t0 = Date.now();

  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`turn timed out after ${TURN_TIMEOUT_MS}ms`)),
      TURN_TIMEOUT_MS
    );
    const unsub = runtime.bus.subscribe((event: PublishedEvent) => {
      const p = event.payload as Record<string, unknown>;
      if (event.topic === "pipeline.stage.completed") {
        stages.push({
          stage: String(p.stage),
          ms: Number(p.durationMs ?? 0),
          ok: p.ok !== false,
          detail: String(p.detail ?? ""),
        });
      }
      if (event.topic === "chat.message.delta" && firstDeltaMs === null) {
        firstDeltaMs = Date.now() - t0;
      }
      if (event.topic === "chat.message.delta") {
        answerChars += String(p.delta ?? "").length;
      }
      if (event.topic === "chat.message.completed") {
        answerDoneMs = Date.now() - t0;
      }
      if (event.topic === "edit.applied") {
        editsApplied.push(String(p.path));
      }
      if (event.topic === "plan.created") {
        planSteps = Array.isArray(p.steps) ? p.steps.length : 0;
      }
      if (event.topic === "plan.step.updated") planUpdates += 1;
      if (event.topic === "tool.started") toolCalls += 1;
      if (event.topic === "task.completed" || event.topic === "task.error") {
        clearTimeout(timer);
        unsub();
        if (event.topic === "task.error") {
          reject(new Error(`task.error: ${String(p.message)}`));
        } else {
          resolve();
        }
      }
    });
  });

  await runtime.router.dispatch(
    "task.start",
    { conversationId, prompt, ...(model ? { model } : {}) },
    ctx
  );
  await done;
  return {
    prompt,
    totalMs: Date.now() - t0,
    firstDeltaMs,
    answerDoneMs,
    stages,
    answerChars,
    editsApplied,
    planSteps,
    planUpdates,
    toolCalls,
  };
}

/**
 * How long after task.completed the background index actually caught up.
 * This is the direct proof the knowledge tail is off the critical path:
 * the turn already ended, and this measures the work that used to block it.
 */
function timeBackgroundIndex(
  runtime: ReturnType<typeof createAgentRuntime>,
  timeoutMs = 60_000
): { done: Promise<number | null>; start: () => void } {
  let t0 = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveDone: (ms: number | null) => void;
  const done = new Promise<number | null>((resolve) => {
    resolveDone = resolve;
  });
  const unsub = runtime.bus.subscribe((event: PublishedEvent) => {
    // Events before start() are the turn's own concurrent indexing; the
    // measurement is only the part still outstanding when the turn ended.
    if (event.topic !== "knowledge.updated" || t0 === 0) return;
    if (timer) clearTimeout(timer);
    unsub();
    resolveDone(Date.now() - t0);
  });
  const start = () => {
    t0 = Date.now();
    // The clock (and its give-up timer) only runs from start(), so a slow
    // turn beforehand cannot eat the observation window.
    timer = setTimeout(() => {
      unsub();
      resolveDone(null);
    }, timeoutMs);
  };
  return { done, start };
}

function printTurn(t: TurnTiming): void {
  console.log(`\n=== "${t.prompt.slice(0, 60)}"`);
  console.log(
    `  total ${(t.totalMs / 1000).toFixed(1)}s · first token ` +
      `${t.firstDeltaMs === null ? "—" : (t.firstDeltaMs / 1000).toFixed(1) + "s"}` +
      ` · answer done ` +
      `${t.answerDoneMs === null ? "—" : (t.answerDoneMs / 1000).toFixed(1) + "s"}` +
      ` · ${t.answerChars} chars`
  );
  for (const s of t.stages) {
    const flag = s.ok ? " " : "!";
    console.log(
      `  ${flag} ${s.stage.padEnd(10)} ${String(s.ms).padStart(6)}ms  ${s.detail.slice(0, 70)}`
    );
  }
  const tail = t.answerDoneMs === null ? null : t.totalMs - t.answerDoneMs;
  if (tail !== null) {
    console.log(`    tail after answer: ${tail}ms`);
  }
  console.log(
    `    ${t.toolCalls} tool call(s) · ${t.editsApplied.length} edit(s)` +
      (t.editsApplied.length > 0 ? ` [${t.editsApplied.join(", ")}]` : "") +
      (t.planSteps !== null
        ? ` · plan: ${t.planSteps} step(s), ${t.planUpdates} update(s)`
        : ` · no plan published`)
  );
}

async function main(): Promise<void> {
  // Optional model override (e.g. "ollama/nemotron-3-super"); the default
  // is whatever the agent defaults to — Claude.
  const model = process.argv[2] || undefined;
  if (model) console.log(`model: ${model}`);
  // A throwaway EXTERNAL workspace: Atelier is a code editor, so the smoke
  // must run it against a repo that is not Atelier's own.
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-turn-ws-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-turn-data-"));
  for (const [rel, content] of Object.entries(SAMPLE_FILES)) {
    const abs = path.join(workspaceRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  const log = pino({ level: process.env.SMOKE_LOG ?? "silent" });
  const config = resolveConfig({
    projectId: "turn-smoke",
    workspaceRoot,
    dataDir,
  });
  const bootT0 = Date.now();
  const runtime = createAgentRuntime(config, log);
  console.log(`runtime boot: ${Date.now() - bootT0}ms`);

  try {
    const ctx = {
      connectionId: "smoke",
      authenticated: true,
      progress: () => undefined,
      signal: new AbortController().signal,
    };
    const { conversation } = (await runtime.router.dispatch(
      "session.createConversation",
      { title: "turn smoke" },
      ctx
    )) as { conversation: { id: string } };

    // Floor first (trivial-chat path), then a real question over the code,
    // then a WRITE turn: edit applied, plan movement, background indexing.
    printTurn(await runTurn(runtime, conversation.id, "hello", model));
    printTurn(
      await runTurn(
        runtime,
        conversation.id,
        "explain how routing works in this app",
        model
      )
    );

    const indexLag = timeBackgroundIndex(runtime);
    const write = await runTurn(
      runtime,
      conversation.id,
      "add a GET /health route to src/server.js that responds with the " +
        "text 'ok', and a DELETE method helper to src/router.js",
      model
    );
    indexLag.start();
    printTurn(write);

    // The write must actually have landed — a smoke that would pass on a
    // turn that only talked about editing is not a write-path smoke.
    const server = fs.readFileSync(
      path.join(workspaceRoot, "src/server.js"),
      "utf8"
    );
    if (write.editsApplied.length === 0 || !/health/.test(server)) {
      throw new Error(
        `write turn made no real edit (edits=${write.editsApplied.length}, ` +
          `health-in-server=${/health/.test(server)})`
      );
    }
    // And the turn must NOT have waited for the index: the knowledge stage
    // is only allowed to block when review is on, which it is not here.
    const knowledge = write.stages.find((s) => s.stage === "knowledge");
    if (knowledge && knowledge.ms > 500) {
      throw new Error(
        `knowledge stage blocked the turn for ${knowledge.ms}ms — the ` +
          "background-index change has regressed"
      );
    }
    const lagMs = await indexLag.done;
    console.log(
      lagMs === null
        ? "    background index: not observed within 60s (may have " +
            "coalesced into an earlier batch)"
        : `    background index caught up ${lagMs}ms AFTER the turn ended`
    );
  } finally {
    runtime.shutdown();
    // WAL handles may briefly outlive shutdown on Windows; best-effort.
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      /* leave temp dirs to the OS */
    }
  }
}

main().then(
  () => {
    console.log("\nturn-smoke: done");
    process.exit(0);
  },
  (error) => {
    console.error(`turn-smoke FAILED: ${String(error)}`);
    process.exit(1);
  }
);
