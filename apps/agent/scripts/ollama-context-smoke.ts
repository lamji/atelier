/**
 * Replays the session that motivated this work — six turns of "is it fixed?"
 * / "it's not" against a stub Ollama daemon — and asserts the model is given
 * what it needs to answer each one.
 *
 * The failures being pinned here are the ones from the real transcript:
 *
 *  1. a follow-up arrived with no record of the answer it was correcting, so
 *     the model repeated the claim the user had just refuted;
 *  2. a second pass of the SAME task (the nudge / gate retry / fix round)
 *     started from an empty transcript and re-read what the pass before it
 *     had already read;
 *  3. a task whose rounds ran out with the completion gate open returned an
 *     empty string, which the UI shows as "No final report was recorded for
 *     this request" and session memory stores as nothing at all.
 *
 * The scripted daemon decides what to answer by looking at the transcript it
 * was actually sent, so a regression shows up as the WRONG ANSWER, not just
 * as a missing message.
 */
import assert from "node:assert/strict";
import { EventBus } from "../src/events/event-bus.js";
import {
  buildMessages,
  capHistory,
  priorTurnMessages,
  runOllamaAgentLoop,
  type OllamaMessage,
  type OllamaRequestInfo,
  type OllamaTranscript,
  type PriorTurn,
} from "../src/providers/ollama/agent-loop.js";
import { SharedSessionContextBuilder } from "../src/context/session/index.js";
import type { ConversationRepo } from "../src/storage/repositories/conversations.js";
import type { TaskSummaryStore } from "../src/context/summaries/index.js";
import { ToolRegistry } from "../src/tools/registry.js";

const TARGET = "finops-crystal-lens/src/lib/multiAccountFallback.ts";

/** What the model said on turn 1, and what the user came back with. */
const WRONG_ANSWER =
  "Yes — it's fixed. The middleware rule is registered and the 422 resolves " +
  "to cost_allocation.no_data.";
const RIGHT_ANSWER =
  "Root cause: fetchPerBillingAccountAndMerge swallows the 422 when another " +
  "billing account returns 200, so the page never sees an error.";
const EDIT_REPORT = "Re-throws the 422 from the fan-out. Edit applied.";

let toolRuns = 0;
const readsOf = new Map<string, number>();
const requests: OllamaRequestInfo[] = [];

function check(name: string, fn: () => void): void {
  fn();
  console.log(`  ok  ${name}`);
}

// ---------------------------------------------------------------- stub daemon

function stream(message: Record<string, unknown>): Response {
  return new Response(`${JSON.stringify({ message, done: true })}\n`, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

function readCall(path: string): Record<string, unknown> {
  return {
    role: "assistant",
    content: "",
    tool_calls: [{ function: { name: "read_file", arguments: { path } } }],
  };
}

/** The newest thing the user (or the completion gate) said. */
function lastUserText(messages: OllamaMessage[]): string {
  return [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
}

/**
 * Whether this transcript already contains a completed read of `path`. The
 * shaped result is the file's bytes and nothing else, so the path lives in
 * the assistant message that asked for it.
 */
function sawRead(messages: OllamaMessage[], path: string): boolean {
  const asked = messages.some(
    (message) =>
      message.role === "assistant" &&
      (message.tool_calls ?? []).some(
        (call) =>
          call.function?.name === "read_file" &&
          JSON.stringify(call.function?.arguments ?? {}).includes(path)
      )
  );
  const answered = messages.some(
    (message) => message.role === "tool" && message.tool_name === "read_file"
  );
  return asked && answered;
}

const originalFetch = globalThis.fetch;

globalThis.fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as {
    messages?: OllamaMessage[];
    tools?: Array<{ function?: { name?: string } }>;
  };
  // /api/show — the capability + context-window probe.
  if (!body.messages) {
    return Response.json({
      model_info: { "smoke.context_length": 8192 },
      capabilities: ["tools"],
    });
  }

  const messages = body.messages;
  const prompt = lastUserText(messages);
  const offered = new Set(
    (body.tools ?? []).map((tool) => tool.function?.name ?? "")
  );

  // Turn 1: the model reads the file and declares victory.
  if (prompt.includes("is it fixed")) {
    return sawRead(messages, TARGET)
      ? stream({ role: "assistant", content: WRONG_ANSWER })
      : stream(readCall(TARGET));
  }

  // Turn 2: the correction. Whether it can be answered depends entirely on
  // whether this request carries what the assistant claimed last turn.
  if (prompt.includes("i can still see the data")) {
    const sawClaim = messages.some(
      (message) =>
        message.role === "assistant" && message.content?.includes("it's fixed")
    );
    // No record of the refuted claim → the model has no reason not to
    // repeat it. This is the regression, reproduced.
    if (!sawClaim) return stream({ role: "assistant", content: WRONG_ANSWER });
    return sawRead(messages, TARGET)
      ? stream({ role: "assistant", content: RIGHT_ANSWER })
      : stream(readCall(TARGET));
  }

  // Turn 3, pass 1: reads the file, then reports without editing — which the
  // completion gate refuses.
  if (prompt.includes("what is this")) {
    return sawRead(messages, TARGET)
      ? stream({ role: "assistant", content: "I have located the fan-out." })
      : stream(readCall(TARGET));
  }

  // Turn 3, pass 2 (the pipeline's nudge to implement). A model that can see
  // its own read in the transcript edits; one that cannot has to read again.
  if (prompt.includes("make the edit now")) {
    if (messages.some((m) => m.role === "tool" && m.tool_name === "replace_code")) {
      return stream({ role: "assistant", content: EDIT_REPORT });
    }
    if (!sawRead(messages, TARGET)) return stream(readCall(TARGET));
    if (!offered.has("replace_code")) {
      // Grounded by the transcript, but the edit tool was withheld anyway.
      return stream({ role: "assistant", content: "I cannot edit from here." });
    }
    return stream({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          function: {
            name: "replace_code",
            arguments: {
              path: TARGET,
              oldString: "return merged;",
              newString: "if (notCovered) throw error;\n  return merged;",
            },
          },
        },
      ],
    });
  }

  // Turn 4: the model keeps reporting, the gate keeps refusing, the rounds
  // run out. Nothing it says this turn is ever accepted.
  if (prompt.includes("expected") || prompt.includes("still unfinished")) {
    return stream({
      role: "assistant",
      content: "Applied the guard to Cud3Page.",
    });
  }

  return stream({ role: "assistant", content: `unscripted: ${prompt}` });
};

// ------------------------------------------------------------------ the drive

interface TurnResult {
  text: string;
  requests: OllamaRequestInfo[];
}

/** One conversation, as the orchestrator keeps it. */
const chat: PriorTurn[] = [];

async function turn(
  prompt: string,
  tools: ToolRegistry,
  opts: {
    taskId: string;
    transcript?: OllamaTranscript;
    completionGate?: () => string;
    onCompletionBlocked?: (reason: string) => void;
    emitText?: (delta: string) => void;
  }
): Promise<TurnResult> {
  const seen: OllamaRequestInfo[] = [];
  const text = await runOllamaAgentLoop({
    model: "context-smoke",
    target: "ollama-local",
    system: "SYSTEM RULES (smoke)",
    prompt,
    // Exactly what Orchestrator.runTask hands the pipeline: the last four
    // messages of the conversation, excluding this turn's own.
    priorTurns: chat.slice(-4),
    tools,
    files: { readFile: async () => ({ content: "return merged;" }) },
    taskId: opts.taskId,
    signal: new AbortController().signal,
    emitText: opts.emitText ?? (() => undefined),
    onRequest: (info) => {
      seen.push(info);
      requests.push(info);
    },
    ...(opts.transcript ? { transcript: opts.transcript } : {}),
    ...(opts.completionGate ? { completionGate: opts.completionGate } : {}),
    ...(opts.onCompletionBlocked
      ? { onCompletionBlocked: opts.onCompletionBlocked }
      : {}),
  });
  return { text, requests: seen };
}

function record(prompt: string, answer: string): void {
  chat.push({ role: "user", text: prompt });
  chat.push({ role: "assistant", text: answer });
}

async function main(): Promise<void> {
  console.log("ollama-context-smoke");
  const bus = new EventBus();
  const tools = new ToolRegistry(bus);
  tools.register("read_file", async (input) => {
    const path = String((input as { path?: string }).path ?? "");
    toolRuns += 1;
    readsOf.set(path, (readsOf.get(path) ?? 0) + 1);
    return { path, content: "return merged;" };
  });
  let edits = 0;
  // The pipeline's completion gate closes on live evidence — here, the edit
  // the turn owed the user actually landing.
  let gateOpen = true;
  tools.register("replace_code", async () => {
    edits += 1;
    gateOpen = false;
    return { applied: true, path: TARGET };
  });

  // --- unit level: what a fresh transcript is seeded with -------------------

  check("prior turns become real user/assistant messages", () => {
    const seeded = priorTurnMessages([
      { role: "user", text: "is it fixed?" },
      { role: "assistant", text: WRONG_ANSWER },
    ]);
    assert.deepEqual(
      seeded.map((message) => message.role),
      ["user", "assistant"]
    );
    assert.equal(seeded[1]?.content, WRONG_ANSWER);
  });

  check("an over-long turn keeps its head and its tail", () => {
    const long = `HEAD${"x".repeat(9000)}TAIL`;
    const [seeded] = priorTurnMessages([{ role: "assistant", text: long }]);
    assert.ok(seeded!.content!.startsWith("HEAD"));
    assert.ok(seeded!.content!.endsWith("TAIL"));
    assert.ok(seeded!.content!.length < 2_000);
  });

  check("only the newest turns are seeded", () => {
    const many: PriorTurn[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `turn ${i}`,
    }));
    const seeded = priorTurnMessages(many);
    assert.equal(seeded.length, 6);
    assert.equal(seeded.at(-1)?.content, "turn 19");
  });

  check("system prompt is rebuilt, history is carried", () => {
    const transcript: OllamaTranscript = {
      messages: [
        { role: "user", content: "original request" },
        { role: "assistant", content: "on it" },
      ],
    };
    const built = buildMessages({
      system: "NEW SYSTEM",
      prompt: "next",
      numCtx: 8192,
      transcript,
      priorTurns: [{ role: "user", text: "should be ignored" }],
    });
    assert.equal(built[0]?.content, "NEW SYSTEM");
    assert.equal(built[1]?.content, "original request");
    assert.equal(built.at(-1)?.content, "next");
    // The transcript wins over priorTurns: it already contains them.
    assert.ok(!built.some((m) => m.content === "should be ignored"));
  });

  check("capped history pins the opening request", () => {
    const messages: OllamaMessage[] = [
      { role: "user", content: "THE ORIGINAL REQUEST" },
      ...Array.from({ length: 40 }, (): OllamaMessage => ({
        role: "tool",
        tool_name: "read_file",
        content: "y".repeat(2000),
      })),
      { role: "assistant", content: "latest" },
    ];
    const capped = capHistory(messages, 500);
    assert.equal(capped[0]?.content, "THE ORIGINAL REQUEST");
    assert.equal(capped.at(-1)?.content, "latest");
    assert.ok(capped.length < messages.length);
    // Never open the carried history on an orphaned tool result.
    assert.notEqual(capped[1]?.role, "tool");
  });

  // --- the conversation ----------------------------------------------------

  const turn1 = await turn("is it fixed?", tools, {
    taskId: "task-1",
    transcript: { messages: [] },
  });
  check("turn 1 answers after reading the file", () => {
    assert.equal(turn1.text, WRONG_ANSWER);
    assert.equal(readsOf.get(TARGET), 1);
  });
  record("is it fixed?", turn1.text);

  const turn2Prompt =
    "its not, i can still see the data in CUD Impact & Effectiveness section";
  const turn2 = await turn(turn2Prompt, tools, {
    taskId: "task-2",
    transcript: { messages: [] },
  });
  check("the correction turn carries the answer it is correcting", () => {
    const opening = turn2.requests[0]!;
    const roles = opening.transcript.map((entry) => entry.role);
    // system, the prior exchange, then this turn's prompt.
    assert.deepEqual(roles, ["system", "user", "assistant", "user"]);
    assert.equal(turn2.text, RIGHT_ANSWER, "model repeated the refuted claim");
  });
  record(turn2Prompt, turn2.text);

  // --- one task, two passes (execute, then the nudge to implement) ----------

  const taskTranscript: OllamaTranscript = { messages: [] };
  const blocked: string[] = [];
  const readsBefore = readsOf.get(TARGET) ?? 0;

  const pass1 = await turn("what is this? its not fix", tools, {
    taskId: "task-3",
    transcript: taskTranscript,
    completionGate: () => (gateOpen ? "no edit has been applied yet" : ""),
    onCompletionBlocked: (reason) => blocked.push(reason),
  });
  const pass2 = await turn(
    "The completion gate is still open — make the edit now.",
    tools,
    {
      taskId: "task-3",
      transcript: taskTranscript,
      completionGate: () => (gateOpen ? "no edit has been applied yet" : ""),
      onCompletionBlocked: (reason) => blocked.push(reason),
    }
  );

  check("a second pass of the same task continues the transcript", () => {
    const opening = pass2.requests[0]!;
    const roles = opening.transcript.map((entry) => entry.role);
    assert.ok(roles.includes("tool"), "pass 2 lost pass 1's tool results");
    assert.equal(
      readsOf.get(TARGET),
      readsBefore + 1,
      "pass 2 re-read a file pass 1 had already read"
    );
  });

  check("edit tools stay unlocked across passes of one task", () => {
    assert.equal(edits, 1, "the nudge could not edit; grounding was lost");
    assert.ok(!pass2.text.includes("cannot edit"));
    assert.ok(pass1.text.length > 0);
  });

  // Runs without a transcript, exactly as the review stage runs without
  // `resume` on Claude — and must leave the implementer's transcript alone.
  const reviewer = await turn("review this change", tools, {
    taskId: "task-3-review",
  });
  check("the reviewer neither reads nor writes the task transcript", () => {
    const opening = reviewer.requests[0]!;
    assert.ok(
      !opening.transcript.some((entry) => entry.role === "tool"),
      "the reviewer inherited the implementer's tool results"
    );
    assert.ok(taskTranscript.messages.some((m) => m.role === "tool"));
  });

  // --- the turn that reported nothing --------------------------------------

  const emitted: string[] = [];
  const stuckBlocked: string[] = [];
  const stuck = await turn("expected", tools, {
    taskId: "task-4",
    transcript: { messages: [] },
    // Never closes: the run spends all 30 rounds and still owes an edit.
    completionGate: () => "still unfinished: 3 plan step(s) open",
    onCompletionBlocked: (reason) => stuckBlocked.push(reason),
    emitText: (delta) => emitted.push(delta),
  });

  check("a gate-exhausted turn still reports what happened", () => {
    assert.notEqual(stuck.text.trim(), "", "turn returned an empty report");
    assert.ok(stuck.text.includes("no final report"));
    assert.ok(stuck.text.includes("still unfinished: 3 plan step(s) open"));
    // The refused progress note survives, marked as refused.
    assert.ok(stuck.text.includes("Applied the guard to Cud3Page."));
    assert.ok(stuck.text.includes("refused"));
    // Chat sees the same thing session memory will store.
    assert.equal(emitted.join(""), stuck.text);
    assert.equal(stuckBlocked.length, MAX_ROUNDS_BLOCKS);
  });

  // --- the recall block must not duplicate what the transcript carries -----

  check("recall skips the turns the transcript already carries", () => {
    const messages = Array.from({ length: 8 }, (_, i) => ({
      id: `m${i}`,
      conversationId: "c1",
      taskId: `t${i}`,
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `turn ${i} body`,
      createdAt: i,
    }));
    const conversations = {
      getMessages: () => messages,
    } as unknown as ConversationRepo;
    const summaries = { recent: () => [] } as unknown as TaskSummaryStore;
    const builder = new SharedSessionContextBuilder({
      conversations,
      summaries,
    });
    const all = builder.build({ conversationId: "c1", currentTaskId: "now" });
    const deduped = builder.build({
      conversationId: "c1",
      currentTaskId: "now",
      verbatimTurns: 4,
    });
    assert.equal(all.turns - deduped.turns, 4);
    assert.ok(deduped.tokens < all.tokens);
    // The newest four are the provider's job now; the older ones are still
    // this block's job and must not have been dropped with them.
    assert.ok(!deduped.text.includes("turn 7 body"));
    assert.ok(deduped.text.includes("turn 3 body"));
  });

  console.log(
    `  ·   ${toolRuns} tool call(s), ${edits} edit(s), ` +
      `${requests.length} model request(s)`
  );
}

/** One refusal per no-tool round the model spends inside a closed gate. */
const MAX_ROUNDS_BLOCKS = 31;

void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
  });
