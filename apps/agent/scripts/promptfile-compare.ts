/**
 * Prompt-file alignment probe: the SAME spec-style note is run as a prompt
 * file on two providers, and each run is judged by what it edited.
 *
 * PASS  — the app code gained the feature; the note itself was not edited
 *         by the model (the journal's own report append doesn't count and
 *         doesn't show up here, because it bypasses the tool registry).
 * FAIL  — the note was "improved" instead of implemented, which is the
 *         exact misbehavior this probe exists to catch.
 *
 *   ELECTRON_RUN_AS_NODE=1 <electron> <tsx-cli> scripts/promptfile-compare.ts \
 *     [modelA] [modelB]
 *
 * Defaults: Claude (picker default) vs ollama/nemotron-3-super.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { composePromptFilePrompt } from "@atelier/shared";
import { createAgentRuntime } from "../src/runtime.js";
import { resolveConfig } from "../src/config/agent-config.js";
import type { PublishedEvent } from "../src/events/event-bus.js";

const TURN_TIMEOUT_MS = Number(process.env.QA_TIMEOUT_MS ?? 300_000);

const NOTE_PATH = ".atelier/Health-module.md";

/** Deliberately shaped like the note that triggered the real bug:
 *  a spec with a "Missing" section, no imperative "implement" opener. */
const NOTE_BODY = [
  "# Health Module",
  "",
  "## Current state",
  "- src/server.js registers /users routes on the router",
  "- Missing",
  "  - no health endpoint at all",
  "  - GET /health should respond with the text 'ok'",
  "  - status code must be 200",
  "",
  "This module belongs in src/server.js using the existing router.",
  "",
].join("\n");

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
  [NOTE_PATH]: NOTE_BODY,
};

interface RunResult {
  model: string;
  totalMs: number;
  edits: string[];
  editedNote: boolean;
  implemented: boolean;
  planSteps: number | null;
  answerHead: string;
  error?: string;
}

async function runOne(model: string | undefined): Promise<RunResult> {
  const label = model ?? "claude(default)";
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-pf-ws-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-pf-data-"));
  for (const [rel, content] of Object.entries(SAMPLE_FILES)) {
    const abs = path.join(workspaceRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const log = pino({ level: process.env.SMOKE_LOG ?? "silent" });
  const runtime = createAgentRuntime(
    resolveConfig({ projectId: `pf-${label}`, workspaceRoot, dataDir }),
    log
  );
  const edits: string[] = [];
  let planSteps: number | null = null;
  let answer = "";
  let error: string | undefined;
  const t0 = Date.now();
  try {
    const ctx = {
      connectionId: "pf-compare",
      authenticated: true,
      progress: () => undefined,
      signal: new AbortController().signal,
    };
    const { conversation } = (await runtime.router.dispatch(
      "session.createConversation",
      { title: `pf ${label}` },
      ctx
    )) as { conversation: { id: string } };

    // Exactly what the composer sends for a picked prompt file.
    const prompt = composePromptFilePrompt(NOTE_BODY, "", NOTE_PATH);

    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout after ${TURN_TIMEOUT_MS}ms`)),
        TURN_TIMEOUT_MS
      );
      const unsub = runtime.bus.subscribe((event: PublishedEvent) => {
        const p = event.payload as Record<string, unknown>;
        // Only MODEL edits count: tool-registry writes carry the taskId.
        // The note journal's own bookkeeping (status flip at start, report
        // append at end) writes without one, and counting those made every
        // prompt-file run look like the model had edited its note.
        if (event.topic === "edit.applied" && event.taskId) {
          edits.push(String(p.path));
        }
        if (event.topic === "plan.created") {
          planSteps = Array.isArray(p.steps) ? p.steps.length : 0;
        }
        if (event.topic === "chat.message.completed") {
          answer = String(p.text ?? "");
        }
        if (event.topic === "task.completed" || event.topic === "task.error") {
          clearTimeout(timer);
          unsub();
          if (event.topic === "task.error") {
            reject(new Error(String(p.message)));
          } else {
            resolve();
          }
        }
      });
    });
    await runtime.router.dispatch(
      "task.start",
      {
        conversationId: conversation.id,
        prompt,
        promptFile: NOTE_PATH,
        ...(model ? { model } : {}),
      },
      ctx
    );
    await done;
  } catch (e) {
    error = String(e);
  }
  const server = fs.readFileSync(path.join(workspaceRoot, "src/server.js"), "utf8");
  const implemented = /health/i.test(server);
  const norm = (p: string) => p.replace(/\\/g, "/");
  const editedNote = edits.some((p) => norm(p).includes(".atelier/"));
  runtime.shutdown();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  } catch {
    /* temp dirs */
  }
  return {
    model: label,
    totalMs: Date.now() - t0,
    edits,
    editedNote,
    implemented,
    planSteps,
    answerHead: answer.replace(/\s+/g, " ").slice(0, 260),
    error,
  };
}

function print(r: RunResult): void {
  const verdict = r.error
    ? `ERROR: ${r.error}`
    : r.implemented && !r.editedNote
      ? "PASS — implemented the spec, left the note alone"
      : r.editedNote && !r.implemented
        ? "FAIL — edited the note instead of implementing (the bug)"
        : r.implemented && r.editedNote
          ? "PARTIAL — implemented but also edited the note"
          : "FAIL — did nothing";
  console.log(`\n=== ${r.model} (${(r.totalMs / 1000).toFixed(1)}s)`);
  console.log(`  ${verdict}`);
  console.log(
    `  edits: ${r.edits.length > 0 ? r.edits.join(", ") : "(none)"}` +
      (r.planSteps !== null ? ` · plan: ${r.planSteps} step(s)` : "")
  );
  console.log(`  answer: ${r.answerHead}`);
}

async function main(): Promise<void> {
  const modelA = process.argv[2] || undefined; // Claude default
  const modelB = process.argv[3] || "ollama/nemotron-3-super";
  print(await runOne(modelA));
  print(await runOne(modelB));
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`promptfile-compare FAILED: ${String(error)}`);
    process.exit(1);
  }
);
