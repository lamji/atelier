/**
 * One-off probe: how good are the agent's answers about a real codebase?
 * Boots the runtime against THIS repo (read-only questions, temp dataDir),
 * asks progressively harder questions, and prints the full answers plus
 * stage timings so the answers can be fact-checked by hand.
 *
 *   ELECTRON_RUN_AS_NODE=1 <electron> <tsx-cli> scripts/codebase-qa-probe.ts \
 *     [workspaceRoot] [question...]
 *
 * With no args it probes THIS repo with the default question set; pass a
 * workspace path (and optionally a question) to point it anywhere else.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { createAgentRuntime } from "../src/runtime.js";
import { resolveConfig } from "../src/config/agent-config.js";
import type { PublishedEvent } from "../src/events/event-bus.js";

const TURN_TIMEOUT_MS = Number(process.env.QA_TIMEOUT_MS ?? 300_000);

const QUESTIONS = [
  // Cross-cutting architecture: needs several files connected correctly.
  "How does a user prompt travel from the chat composer to the model and " +
    "back to the screen? Name the actual files and the transport involved.",
  // Precise current behavior: easy to get stale/wrong from comments alone.
  "Which pipeline stages can cost a model call on a normal chat turn, and " +
    "under what conditions do validate and review actually run?",
  // Reasoning, not lookup: has to understand an invariant, not quote it.
  "In the agent's IPC bridge, could a chat.message.completed event ever " +
    "overtake the streamed deltas of its own message? Explain why or why not.",
];

interface Answer {
  question: string;
  text: string;
  totalMs: number;
  retrieval: string;
  toolCalls: number;
  edits: number;
}

async function ask(
  runtime: ReturnType<typeof createAgentRuntime>,
  conversationId: string,
  question: string
): Promise<Answer> {
  const ctx = {
    connectionId: "qa-probe",
    authenticated: true,
    progress: () => undefined,
    signal: new AbortController().signal,
  };
  let text = "";
  let retrieval = "none";
  let toolCalls = 0;
  let edits = 0;
  const t0 = Date.now();
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("turn timeout")),
      TURN_TIMEOUT_MS
    );
    const unsub = runtime.bus.subscribe((event: PublishedEvent) => {
      const p = event.payload as Record<string, unknown>;
      if (event.topic === "chat.message.completed") text = String(p.text ?? "");
      if (event.topic === "knowledge.retrieved") {
        retrieval = String(p.strategy ?? "?");
      }
      if (event.topic === "tool.started") {
        toolCalls += 1;
        // Live trail on stderr, so a long run shows where the time goes.
        const name = String(p.name ?? "?");
        const input = (p.input ?? {}) as Record<string, unknown>;
        const hint = String(
          input.path ?? input.pattern ?? input.query ?? input.command ?? ""
        ).slice(0, 60);
        console.error(
          `    [${((Date.now() - t0) / 1000).toFixed(0)}s] ${name} ${hint}`
        );
      }
      if (event.topic === "edit.applied") edits += 1;
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
    { conversationId, prompt: question },
    ctx
  );
  await done;
  return {
    question,
    text,
    totalMs: Date.now() - t0,
    retrieval,
    toolCalls,
    edits,
  };
}

async function main(): Promise<void> {
  // Workspace from argv, else THIS repo; agent data goes to a throwaway
  // dir either way so no real per-project DB is touched.
  const workspaceRoot = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(import.meta.dirname, "../../..");
  const question = process.argv.slice(3).join(" ").trim();
  const questions = question ? [question] : QUESTIONS;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-qa-data-"));
  const log = pino({ level: process.env.SMOKE_LOG ?? "silent" });
  const runtime = createAgentRuntime(
    resolveConfig({ projectId: "qa-probe", workspaceRoot, dataDir }),
    log
  );
  try {
    const ctx = {
      connectionId: "qa-probe",
      authenticated: true,
      progress: () => undefined,
      signal: new AbortController().signal,
    };
    const { conversation } = (await runtime.router.dispatch(
      "session.createConversation",
      { title: "codebase qa probe" },
      ctx
    )) as { conversation: { id: string } };

    for (const q of questions) {
      const a = await ask(runtime, conversation.id, q);
      console.log(`\n${"=".repeat(72)}`);
      console.log(`Q: ${a.question}`);
      console.log(
        `   (${(a.totalMs / 1000).toFixed(1)}s · retrieval ${a.retrieval} · ` +
          `${a.toolCalls} tool call(s) · ${a.edits} edit(s))`
      );
      console.log(`\n${a.text}`);
      if (a.edits > 0) {
        throw new Error("read-only probe made an edit — abort and inspect");
      }
    }
  } finally {
    runtime.shutdown();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* temp dir; OS will collect it */
    }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`qa-probe FAILED: ${String(error)}`);
    process.exit(1);
  }
);
