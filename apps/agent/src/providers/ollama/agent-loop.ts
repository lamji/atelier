import { approxTokens } from "@atelier/shared";
import type { ImageAttachment } from "@atelier/protocol";
import type { ToolRegistry } from "../../tools/registry.js";
import { shapeToolOutput } from "../../context/tool-output/index.js";
import type { OllamaTarget } from "../model-routing.js";
import { OLLAMA_CLOUD, setModelSubscriptionRequired } from "../credentials.js";
import {
  editsOf,
  explainEditFailure,
  isEditTool,
  prepareEdit,
  type EditFileReader,
  type EditInput,
} from "./edit-repair.js";
import {
  isOllamaSubscriptionRequired,
  ollamaApiKey,
  ollamaHost,
  resolveNumCtx,
  supportsThinking,
} from "./client.js";
import { recordCloudUsage } from "./usage.js";

/**
 * Idle cap, not a total cap. With streaming on, "no bytes for two minutes"
 * means the endpoint is dead; a healthy long generation keeps the stream
 * moving and is allowed to take as long as it takes. The old TOTAL cap of
 * 120s silently killed any turn whose full generation ran past it — which
 * on a large cloud model was most substantial turns.
 */
const IDLE_TIMEOUT_MS = 120_000;
const MAX_TOOL_ROUNDS = 30;
const TOOL_BUDGET_FINAL_INSTRUCTION =
  "The tool budget for this user turn is exhausted. Do not call any more " +
  "tools. Give the user a concise final response stating what you completed, " +
  "what remains, and any blocker.";

/**
 * Verbatim chat turns seeded into a task's first Ollama call.
 *
 * Ollama has no session id to resume, so without this the model meets every
 * follow-up ("it's still not fixed") with no idea what it answered a minute
 * ago. The compressed recall block in the system prompt is a summary of the
 * exchange; these are the exchange.
 */
const MAX_PRIOR_TURNS = 6;

/** How far a single seeded turn is quoted. */
const MAX_PRIOR_TURN_CHARS = 1_600;

/**
 * Share of the model's window the carried history may take.
 *
 * The rest pays for the system prompt, the tool schemas and this call's own
 * tool loop. Ollama truncates an over-long prompt daemon-side, in silence
 * and from the front, so the budget has to be enforced here where the
 * original request can be protected.
 */
const HISTORY_SHARE = 0.3;

type JsonSchema = Record<string, unknown>;

interface OllamaToolCall {
  function?: {
    name?: string;
    arguments?: unknown;
  };
}

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  /** Reasoning models stream their hidden pass here, apart from content. */
  thinking?: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaChatResponse {
  message?: OllamaMessage;
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

/** One earlier exchange in the chat, as it was actually written. */
export interface PriorTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * One task's live Ollama transcript, owned by the caller.
 *
 * Claude keeps this inside the SDK and Atelier resumes it by id. Ollama's
 * /api/chat is stateless, so the array itself is the session: the pipeline
 * holds one per task and hands it back on every call the task makes — the
 * execute pass, a nudge to implement, a completion-gate retry, a validation
 * fix round. Without it each of those restarts from an empty transcript and
 * re-reads every file the pass before it had already read.
 */
export interface OllamaTranscript {
  /** Everything but the system message, which is rebuilt per call. */
  messages: OllamaMessage[];
  /**
   * Files this task has already read, across passes. The blind-edit guard is
   * per-pass by design, but once the transcript carries over, a pass that can
   * SEE its own earlier read would still be refused the edit tools and have
   * to read the file again to earn them — the exact read/plan/read loop the
   * carried transcript exists to end.
   */
  readPaths?: string[];
}

export interface OllamaAgentLoopOptions {
  model: string;
  /** Which endpoint serves this model — the daemon here, or the cloud. */
  target?: OllamaTarget;
  system: string;
  prompt: string;
  images?: ImageAttachment[];
  /**
   * The chat before this turn, oldest first. Seeds a task's FIRST call; a
   * later call in the same task inherits them through `transcript`.
   */
  priorTurns?: PriorTurn[];
  /**
   * The task's transcript. Present = continue it and write this call's
   * messages back into it. Absent = a deliberately independent session,
   * which is what the review stage runs.
   */
  transcript?: OllamaTranscript;
  tools: ToolRegistry;
  /**
   * Read side of the workspace, for the edit-repair pass. It is the same
   * path-guarded FileService the tools use, so a repair can never read
   * outside the workspace to build its diagnostics.
   */
  files: EditFileReader;
  /**
   * Narrows the tool surface offered to the model. Undefined offers every
   * Atelier tool; a list is how direct mode (system knowledge off) keeps
   * the knowledge tools out of the loop entirely.
   */
  toolNames?: string[];
  /**
   * Files whose exact current content the system context already carries
   * (the pipeline's "previously gathered" block). They count as read for
   * the blind-edit guard: demanding a read_file of bytes the model is
   * already holding was the loop that made every follow-up start over.
   */
  preGrounded?: string[];
  /**
   * The task's reasoning-effort pick. On a model with the thinking
   * capability this decides the hidden pass: high effort turns it on,
   * everything else turns it OFF. Thinking is where a reasoning model
   * spends the bulk of its wall clock — measured on nemotron-3-super it
   * was ~85 of a 95-second turn — and it runs before every tool round,
   * so a default-effort turn pays it three or four times over.
   */
  effort?: string;
  taskId: string;
  signal: AbortSignal;
  emitText: (delta: string) => void;
  /**
   * Live evidence checked before a no-tool response may become the final
   * report. The pipeline owns the evidence; the provider loop only enforces
   * the verdict while it still has the same transcript and tool results.
   */
  completionGate?: () => string;
  /** Announces a refused report on the shared hook rail. */
  onCompletionBlocked?: (reason: string) => void;
  /** Thinking deltas, for the same live surface Claude's thinking uses. */
  emitThinking?: (delta: string) => void;
  /**
   * Called before EVERY /api/chat round with what is about to be sent.
   * The pipeline turns it into the timeline's "sent to model" row; the
   * loop only knows the numbers (window, transcript size, tools offered).
   */
  onRequest?: (info: OllamaRequestInfo) => void;
}

export interface OllamaRequestInfo {
  /** 0 is the opening request; every tool round after it counts up. */
  round: number;
  /** The context window this request asks for (num_ctx). */
  contextWindow: number;
  toolsOffered: number;
  /** One entry per message in the replayed transcript, sized. */
  transcript: Array<{ role: string; chars: number; label?: string }>;
  /** Total characters of the transcript, for a token estimate. */
  transcriptChars: number;
  /** Older tool results whose bodies were elided to fit the window. */
  elided: number;
}

/**
 * Sizes the transcript for the request row without copying it. Tool
 * results carry the tool's name and assistant messages the tools they
 * called, which is enough to see WHICH round blew the window and why.
 */
export function describeTranscript(
  messages: OllamaMessage[]
): Pick<OllamaRequestInfo, "transcript" | "transcriptChars"> {
  let transcriptChars = 0;
  const transcript = messages.map((message) => {
    const chars =
      (message.content?.length ?? 0) +
      (message.thinking?.length ?? 0) +
      (message.tool_calls ? safeJson(message.tool_calls).length : 0);
    transcriptChars += chars;
    const label =
      message.role === "tool"
        ? message.tool_name
        : message.tool_calls && message.tool_calls.length > 0
          ? `calls ${message.tool_calls
              .map((call) => call.function?.name ?? "?")
              .join(", ")}`
          : undefined;
    return { role: message.role, chars, ...(label ? { label } : {}) };
  });
  return { transcript, transcriptChars };
}

/**
 * Tool-capable Ollama execution path. This mirrors the Claude SDK session at
 * the boundary that matters to Atelier: the model sees the same workspace
 * tools, ToolRegistry still enforces hooks and emits tool events, and tool
 * results are fed back to the model until it returns normal assistant text.
 */
export async function runOllamaAgentLoop(
  opts: OllamaAgentLoopOptions
): Promise<string> {
  const offered = atelierToolsFor(opts.toolNames);
  const target = opts.target ?? "ollama-cloud";
  // Sized from the model, once per run. The tool loop replays every result
  // on every turn, so this is the number that decides whether the rules and
  // the assembled context survive to the end of the task.
  const numCtx = await resolveNumCtx(opts.model, target);
  const messages = buildMessages({
    system: opts.system,
    prompt: opts.prompt,
    numCtx,
    ...(opts.images ? { images: opts.images } : {}),
    ...(opts.priorTurns ? { priorTurns: opts.priorTurns } : {}),
    ...(opts.transcript ? { transcript: opts.transcript } : {}),
  });
  // Ollama does not have the SDK's persistent working-set awareness. Keep a
  // small proof ledger so stale retrieval or session summaries can inform
  // investigation but can never authorize a blind patch. It spans the task's
  // passes with the transcript, and nothing wider.
  const grounding: EditGrounding = {
    required: true,
    discovered: false,
    readPaths: new Set<string>(),
    // Repeated-read detection stays per-pass: a fresh pass opening with a
    // verification read of a file it changed is doing the right thing.
    readCalls: new Set<string>(),
  };
  for (const path of [
    ...(opts.preGrounded ?? []),
    ...(opts.transcript?.readPaths ?? []),
  ]) {
    grounding.readPaths.add(pathKey(path));
    grounding.discovered = true;
  }
  // The transcript is this task's session. Committed in a finally so a
  // cancelled or failed pass still leaves its reads to the pass that
  // follows — re-reading the same files is the cost this exists to avoid.
  const commit = (): void => {
    if (!opts.transcript) return;
    opts.transcript.messages = messages.slice(1);
    opts.transcript.readPaths = [...grounding.readPaths];
  };
  try {
    return await toolLoop(opts, messages, grounding, offered, target, numCtx);
  } finally {
    commit();
  }
}

async function toolLoop(
  opts: OllamaAgentLoopOptions,
  messages: OllamaMessage[],
  grounding: EditGrounding,
  offered: JsonSchema[],
  target: OllamaTarget,
  numCtx: number
): Promise<string> {
  let text = "";
  /** Failing calls, by signature — see noteFailure. */
  const failures = new Map<string, number>();
  /** Tool calls run, and the last report the gate refused — see endOfTurn. */
  let toolCalls = 0;
  let refused = "";
  const callDeps: ToolCallDeps = { ...opts, grounding };

  // Only sent to models that advertise the capability — /api/chat rejects
  // `think` on anything else. High effort opts in; the default is OFF,
  // because the hidden pass re-runs before every tool round and is the
  // difference between an Ollama turn and a Claude turn taking the same
  // path in minutes versus seconds.
  const think = (await supportsThinking(opts.model, target))
    ? ["high", "xhigh", "max", "ultra"].includes(opts.effort ?? "")
    : undefined;

  for (let turn = 0; turn < MAX_TOOL_ROUNDS; turn++) {
    // Buffer visible text until the response boundary reveals whether this
    // is a tool call, an incomplete report the completion hook must refuse,
    // or the one final report that is safe to render.
    let roundText = "";
    const roundTools = groundedToolsFor(offered, grounding);
    // Ollama drops whatever does not fit the window on its own terms —
    // oldest messages first, then the front of the token stream, which is
    // the rules. Eliding old tool results HERE keeps the drop deliberate
    // and visible instead of silent, and keeps the rules intact.
    const elided = fitToWindow(messages, numCtx, roundTools.length);
    announceRound(opts, turn, messages, roundTools, numCtx, elided);
    const message = await ollamaChatStreaming(
      opts.model,
      target,
      messages,
      roundTools,
      numCtx,
      think,
      opts.signal,
      (delta) => {
        roundText += delta;
      },
      opts.emitThinking
    );
    messages.push(message);

    const calls = message.tool_calls?.filter((call) => call.function?.name) ?? [];
    if (calls.length === 0) {
      const outstanding = opts.completionGate?.() ?? "";
      if (outstanding) {
        // Ollama has no native Stop hook. Treat a no-tool answer as its Stop
        // boundary, keep the candidate report off chat, and feed the live
        // reason back into this SAME transcript so the model can still use
        // every read and tool result it already paid for.
        opts.onCompletionBlocked?.(outstanding);
        // Kept, not shown. If the rounds run out before the gate clears, this
        // is the only account of what the model believed it had done, and a
        // turn that reports nothing at all is worse than one that reports
        // unfinished work with the verdict attached.
        if (roundText.trim()) refused = roundText;
        messages.push({ role: "user", content: outstanding });
        continue;
      }
      text += roundText;
      if (roundText) opts.emitText(roundText);
      return endOfTurn(opts, text, {
        rounds: turn + 1,
        toolCalls,
        refused,
        outstanding: "",
      });
    }

    // A round whose calls are ALL read-only runs them concurrently — the
    // model batched them because it needs the results together, and each
    // one paid sequentially is wall-clock the user watches. Anything that
    // can mutate keeps strict order.
    const named = calls
      .filter((call) => call.function?.name)
      .map((call) => ({
        name: call.function!.name!,
        input: normalizeToolArguments(call.function?.arguments),
      }));
    const results = named.every((call) => PARALLEL_SAFE.has(call.name))
      ? await Promise.all(
          named.map((call) =>
            runCall(call.name, call.input, callDeps)
          )
        )
      : await runSequential(named, callDeps);
    toolCalls += named.length;
    named.forEach((call, i) => {
      messages.push({
        role: "tool",
        tool_name: call.name,
        content: noteFailure(failures, call, results[i]!),
      });
    });
  }

  // This budget belongs only to this invocation; the pipeline's next pass
  // starts at round zero (with the transcript, not the rounds, carried over).
  // Never spend the forced tool-free handoff on an incomplete implementation:
  // the pipeline can start another bounded pass, but it cannot retract a
  // partial report once chat has rendered it.
  const outstanding = opts.completionGate?.() ?? "";
  if (outstanding) {
    opts.onCompletionBlocked?.(outstanding);
    return endOfTurn(opts, text, {
      rounds: MAX_TOOL_ROUNDS,
      toolCalls,
      refused,
      outstanding,
    });
  }
  messages.push({ role: "system", content: TOOL_BUDGET_FINAL_INSTRUCTION });
  let finalText = "";
  announceRound(opts, MAX_TOOL_ROUNDS, messages, [], numCtx, fitToWindow(messages, numCtx, 0));
  await ollamaChatStreaming(
    opts.model,
    target,
    messages,
    [],
    numCtx,
    think,
    opts.signal,
    (delta) => {
      finalText += delta;
    },
    opts.emitThinking
  );
  text += finalText;
  if (finalText) opts.emitText(finalText);
  return endOfTurn(opts, text, {
    rounds: MAX_TOOL_ROUNDS,
    toolCalls,
    refused,
    outstanding: "",
  });
}

/**
 * A turn must never end silently.
 *
 * An empty return renders as "No final report was recorded for this request",
 * and — the part that actually compounds — it is what the task summary stores,
 * so the NEXT turn recalls a task with no record of what was done. The user is
 * then the only one who remembers, which is how a session turns into "is it
 * fixed?" / "it's not" four times over. Every silent ending has an account
 * available: the rounds spent, the tools run, and the report the completion
 * gate refused.
 */
function endOfTurn(
  opts: OllamaAgentLoopOptions,
  text: string,
  run: {
    rounds: number;
    toolCalls: number;
    refused: string;
    outstanding: string;
  }
): string {
  if (text.trim()) return text;
  const lines = [
    "_This turn produced no final report._",
    `- ${run.rounds} tool round(s) spent, ${run.toolCalls} tool call(s) run`,
  ];
  if (run.outstanding) {
    lines.push(`- work still outstanding: ${run.outstanding}`);
  }
  if (run.refused.trim()) {
    lines.push(
      "- the model's last progress note, refused as a final report because " +
        "the work above was unfinished:",
      `> ${clipReport(run.refused).replaceAll("\n", "\n> ")}`
    );
  }
  const note = lines.join("\n");
  opts.emitText(note);
  return note;
}

/** Enough of a refused report to recognise the work, never the whole thing. */
function clipReport(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 800 ? `${trimmed.slice(0, 800)}…` : trimmed;
}

function announceRound(
  opts: OllamaAgentLoopOptions,
  round: number,
  messages: OllamaMessage[],
  tools: JsonSchema[],
  numCtx: number,
  elided: number
): void {
  if (!opts.onRequest) return;
  try {
    opts.onRequest({
      round,
      contextWindow: numCtx,
      toolsOffered: tools.length,
      elided,
      ...describeTranscript(messages),
    });
  } catch {
    // A reporting problem must never stop the round.
  }
}

/**
 * Share of the window a request may fill before old tool results go. The
 * rest is headroom for the answer and for the estimate being rough.
 */
const WINDOW_FILL = 0.85;
/** The newest tool results are what the model is reasoning about; kept. */
const KEEP_RECENT_TOOL_RESULTS = 4;
/** Rough cost of one offered tool schema, in tokens. */
const TOOL_SCHEMA_TOKENS = 60;
const ELIDED_MARK = "[elided";

/**
 * Keeps the request inside the context window by eliding the BODIES of
 * older tool results, oldest first, until it fits. The system prompt, the
 * user's request, every assistant message and the newest tool results are
 * never touched.
 *
 * Without this the transcript of a long tool loop simply outgrew the
 * window and Ollama truncated it silently: the model then answered from
 * rules it could no longer see and file contents it no longer had — the
 * confident, wrong turn that reads as hallucination. An elided result says
 * it was elided and how to get it back, which is a very different thing
 * from a result that vanished. Returns how many results were elided.
 */
export function fitToWindow(
  messages: OllamaMessage[],
  numCtx: number,
  toolsOffered: number
): number {
  const limit = Math.floor(numCtx * WINDOW_FILL) - toolsOffered * TOOL_SCHEMA_TOKENS;
  let total = messages.reduce((sum, message) => sum + messageTokens(message), 0);
  if (total <= limit) return 0;
  const toolIndexes = messages
    .map((message, index) => (message.role === "tool" ? index : -1))
    .filter((index) => index >= 0);
  const candidates = toolIndexes.slice(
    0,
    Math.max(0, toolIndexes.length - KEEP_RECENT_TOOL_RESULTS)
  );
  let elided = 0;
  for (const index of candidates) {
    if (total <= limit) break;
    const message = messages[index]!;
    const body = message.content ?? "";
    if (body.length < 400 || body.startsWith(ELIDED_MARK)) continue;
    const before = messageTokens(message);
    const head = body.slice(0, 160).replace(/\s+/g, " ");
    message.content =
      `${ELIDED_MARK} to fit the ${numCtx}-token context window: this ` +
      `${message.tool_name ?? "tool"} result was ${body.length} chars and ` +
      `began "${head}…". Call the tool again if you need it.]`;
    total -= before - messageTokens(message);
    elided += 1;
  }
  return elided;
}

/** Tools that cannot mutate the workspace, safe to run concurrently. */
const PARALLEL_SAFE = new Set([
  "read_file",
  "read_many_files",
  "list_dir",
  "search_workspace",
  "search_text",
  "retrieve_knowledge",
  "query_knowledge_graph",
  "search_symbols",
  "impact_of_edit",
  "analyze_impact",
]);

/**
 * Ollama gets an explicit investigation phase. Unlike Codex's coding
 * runtime, a raw /api/chat model has no native search-first behavior: if
 * mutation schemas are visible beside retrieved summaries it can jump from
 * an old summary straight to a plausible patch. Keep every mutation route
 * out of the schema until this turn has grounded at least one live file.
 * A successful direct read counts as both location and current-code proof;
 * forcing a redundant search after an exact anchored path strands local
 * models on a read/update-plan loop with no edit schema to call.
 */
const MUTATION_TOOLS = new Set([
  "write_file",
  "replace_code",
  "replace_many",
  "run_terminal",
]);

export function groundedToolsFor(
  tools: JsonSchema[],
  grounding: EditGrounding
): JsonSchema[] {
  if (editGrounded(grounding)) return tools;
  return tools.filter((schema) => !MUTATION_TOOLS.has(toolNameOf(schema)));
}

function editGrounded(grounding: EditGrounding): boolean {
  return grounding.discovered && grounding.readPaths.size > 0;
}

async function runSequential(
  calls: Array<{ name: string; input: unknown }>,
  opts: ToolCallDeps
): Promise<string[]> {
  const results: string[] = [];
  for (const call of calls) {
    results.push(await runCall(call.name, call.input, opts));
  }
  return results;
}

/** What running a single call needs — a subset of the loop's options. */
export interface ToolCallDeps {
  tools: ToolRegistry;
  files: EditFileReader;
  taskId: string;
  signal: AbortSignal;
  /** Present only on Ollama turns; Grok keeps its existing tool behavior. */
  grounding?: EditGrounding;
}

export interface EditGrounding {
  required: boolean;
  discovered: boolean;
  readPaths: Set<string>;
  /** Exact successful reads in this unchanged workspace state. */
  readCalls: Set<string>;
}

/**
 * One tool call. Edits take the repair path — every other tool goes
 * straight to the registry, exactly as before. Exported for the smoke,
 * which drives it against a real registry and a real workspace.
 */
export async function runCall(
  name: string,
  input: unknown,
  opts: ToolCallDeps
): Promise<string> {
  if (!isEditTool(name)) {
    const repeatedRead = repeatedReadFailure(opts.grounding, name, input);
    if (repeatedRead) return repeatedRead;

    const editsWereLocked =
      opts.grounding?.required === true && !editGrounded(opts.grounding);
    const result = await runTool(
      opts.tools,
      name,
      input,
      opts.taskId,
      opts.signal
    );
    recordGrounding(opts.grounding, name, input, result);
    if (
      editsWereLocked &&
      opts.grounding &&
      editGrounded(opts.grounding)
    ) {
      return (
        result +
        "\n\nGrounding complete: replace_code and replace_many are now " +
        "available. Keep the existing timeline, ensure its current step is " +
        "in-progress, and make the requested edit now. Do not repeat this " +
        "read or rewrite the plan."
      );
    }
    return result;
  }
  const malformed = malformedEditInput(name, input);
  if (malformed) return malformed;
  const edits = editsOf(name, input);
  // Arguments this module does not recognise stay the registry's problem;
  // its schema errors are better than anything guessed here. Required edit
  // strings are the exception: validate the whole call before expanding a
  // batch so one malformed entry cannot be silently dropped while its
  // siblings mutate files.
  if (edits.length === 0) {
    return runTool(opts.tools, name, input, opts.taskId, opts.signal);
  }
  const blocked = groundingFailure(opts.grounding, edits);
  if (blocked) return blocked;
  // A batch is expanded into one replace_code per edit. `replace_many`
  // builds the whole result in memory and writes once, so a single stale
  // oldString threw away the edits that DID match and the model reran the
  // lot — the "Editing 2 replacements / oldString not found" pair, over
  // and over. Run apart, each edit lands or fails on its own, the good
  // ones stay on disk, and the UI shows one honest row per edit.
  const results: string[] = [];
  for (const edit of edits) {
    const result = await runEdit(edit, opts);
    results.push(result);
    if (!/(^|\n)Error:/.test(result) && !result.startsWith("Already applied")) {
      // The file changed, so a same-input read is useful again as
      // verification rather than a loop.
      opts.grounding?.readCalls.clear();
    }
  }
  return results.join("\n");
}

const DISCOVERY_TOOLS = new Set([
  "search_workspace",
  "search_text",
  "search_symbols",
  "query_knowledge_graph",
]);

function recordGrounding(
  grounding: EditGrounding | undefined,
  name: string,
  input: unknown,
  result: string
): void {
  if (!grounding?.required || /(^|\n)Error:/.test(result)) return;
  if (DISCOVERY_TOOLS.has(name)) grounding.discovered = true;

  const value = input as Record<string, unknown> | undefined;
  const readCall = readCallKey(name, input);
  if (name === "read_file" && typeof value?.path === "string") {
    grounding.readPaths.add(pathKey(value.path));
    if (readCall) grounding.readCalls.add(readCall);
    grounding.discovered = true;
    return;
  }
  if (name !== "read_many_files" || !Array.isArray(value?.files)) return;
  let readAny = false;
  for (const entry of value.files) {
    const path = (entry as { path?: unknown })?.path;
    if (typeof path !== "string") continue;
    // The compact read-many shaper emits a header only for successful reads.
    if (result.includes(`### ${path}`)) {
      grounding.readPaths.add(pathKey(path));
      grounding.discovered = true;
      readAny = true;
    }
  }
  if (readAny && readCall) grounding.readCalls.add(readCall);
}

function repeatedReadFailure(
  grounding: EditGrounding | undefined,
  name: string,
  input: unknown
): string | null {
  if (!grounding?.required) return null;
  const key = readCallKey(name, input);
  if (!key || !grounding.readCalls.has(key)) return null;
  return (
    `Error: this exact ${name} input already succeeded and the workspace ` +
    "has not changed since. Do not read it again. Use replace_code or " +
    "replace_many now to execute the active timeline step."
  );
}

function readCallKey(name: string, input: unknown): string | null {
  if (name !== "read_file" && name !== "read_many_files") return null;
  return `${name}:${safeJson(input)}`;
}

function groundingFailure(
  grounding: EditGrounding | undefined,
  edits: EditInput[]
): string | null {
  if (!grounding?.required) return null;
  if (!grounding.discovered) {
    return (
      "Error: blind edit blocked. Locate the live owner first with " +
      "search_text, search_workspace, search_symbols, or " +
      "query_knowledge_graph. Retrieved/session-memory text is context, not " +
      "proof of the current code path."
    );
  }
  const unread = [...new Set(edits.map((edit) => edit.path))].filter(
    (path) => !grounding.readPaths.has(pathKey(path))
  );
  if (unread.length === 0) return null;
  return (
    `Error: blind edit blocked. Read the current target file(s) before ` +
    `editing: ${unread.join(", ")}. Trace the trigger and caller/data flow ` +
    "when the behavior crosses components."
  );
}

function pathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Names the missing string fields when an edit tool's `input` is not the
 * shape the model should have sent — undefined, null, or a non-object.
 * `editsOf` returns `[]` for these inputs, so without this guard the call
 * falls through to the shared tool and surfaces a generic schema error
 * only after the file has been read. Failing here is cheap, and the model
 * sees a message that points at the field it has to add, not at the file
 * it has to re-read.
 */
function malformedEditInput(name: string, input: unknown): string | null {
  const fields = ["path", "oldString", "newString"];
  if (name === "replace_code") {
    return missingEditFields("replace_code", fields, input);
  }
  if (name !== "replace_many") return null;
  const value = input as { edits?: unknown } | null | undefined;
  if (!value || typeof value !== "object" || !Array.isArray(value.edits)) {
    return (
      `Error: replace_many missing or non-array "edits". Re-send the call ` +
      "with edits as an array of objects, each having path, oldString, " +
      "and newString as strings."
    );
  }
  for (let index = 0; index < value.edits.length; index += 1) {
    const missing = missingEditFields(
      `replace_many edits[${index}]`,
      fields,
      value.edits[index]
    );
    if (missing) return missing;
  }
  return null;
}

function missingEditFields(
  name: string,
  fields: string[],
  input: unknown
): string | null {
  if (!input || typeof input !== "object") {
    return (
      `Error: ${name} called with non-object input (got ` +
      `${input === undefined ? "undefined" : input === null ? "null" : typeof input}). ` +
      `Re-send the call with an object containing ${fields.join(", ")} ` +
      "as strings."
    );
  }
  const value = input as Record<string, unknown>;
  const missing = fields.filter((field) => typeof value[field] !== "string");
  if (missing.length === 0) return null;
  return (
    `Error: ${name} missing required string field(s): ${missing.join(", ")}. ` +
    `Re-send the call with ${fields.join(", ")} all as strings.`
  );
}

/** Repair, run, and on a miss answer with something actionable. */
async function runEdit(
  edit: EditInput,
  opts: ToolCallDeps
): Promise<string> {
  // The model sometimes drops one of the required string fields. The shared
  // tool throws a specific message for that, but only AFTER the tool has
  // read the file from disk; do the same shape check up front so a
  // malformed call short-circuits before any I/O and before prepareEdit
  // runs matchEdit against an undefined oldString.
  const missing: string[] = [];
  if (typeof edit.path !== "string") missing.push("path");
  if (typeof edit.oldString !== "string") missing.push("oldString");
  if (typeof edit.newString !== "string") missing.push("newString");
  if (missing.length > 0) {
    return (
      `Error: replace_code missing required string field(s): ` +
      `${missing.join(", ")}. Re-send the call with path, oldString, and ` +
      "newString all as strings."
    );
  }
  let input = edit;
  try {
    const prepared = await prepareEdit(opts.files, edit);
    // Nothing to do: the file already says what the edit asks for. Calling
    // the tool would only produce a red row for a no-op.
    if (prepared.status === "noop") return prepared.message;
    input = prepared.input;
  } catch {
    // Repair is an assist, never a gate — fall through with what the model
    // sent and let the tool have the final word.
  }
  try {
    const result = await opts.tools.run(
      "replace_code",
      input,
      opts.taskId,
      opts.signal
    );
    return shapeToolOutput("replace_code", result);
  } catch (error) {
    if (opts.signal.aborted) throw error;
    try {
      return await explainEditFailure(opts.files, input, error);
    } catch {
      return `Error: ${String(error)}`;
    }
  }
}

/**
 * Counts repeats of the same failing call and, from the second one on,
 * says so. A local model that gets an identical error twice will happily
 * send it a third and a fourth time until MAX_TOOL_ROUNDS runs out; naming the
 * repetition is what breaks the cycle, because the transcript otherwise
 * looks to the model like a fresh attempt every time.
 */
function noteFailure(
  failures: Map<string, number>,
  call: { name: string; input: unknown },
  result: string
): string {
  if (!/(^|\n)Error:/.test(result)) return result;
  const signature = `${call.name}:${safeJson(call.input)}`;
  const seen = (failures.get(signature) ?? 0) + 1;
  failures.set(signature, seen);
  if (seen < 2) return result;
  return (
    `${result}\n\nYou have now sent this exact call ${seen} times and it ` +
    "failed the same way each time. Do not send it again. Read the file " +
    "with read_file and work from what it actually contains, or take a " +
    "different approach to this step."
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * The message array for one /api/chat call.
 *
 * The system message is rebuilt every time — the assembled context, the scope
 * lock and the plan all move between passes — while everything after it is
 * conversation and carries over. Within a task that history is the task's own
 * transcript (reads, tool results, what the model already said); on the task's
 * first call there is none yet, so the chat turns stand in for it.
 */
export function buildMessages(input: {
  system: string;
  prompt: string;
  numCtx: number;
  images?: ImageAttachment[];
  priorTurns?: PriorTurn[];
  transcript?: OllamaTranscript;
}): OllamaMessage[] {
  const carried = input.transcript?.messages ?? [];
  const history =
    carried.length > 0
      ? capHistory(carried, Math.floor(input.numCtx * HISTORY_SHARE))
      : priorTurnMessages(input.priorTurns);
  return [
    { role: "system", content: input.system },
    ...history,
    userMessage(input.prompt, input.images),
  ];
}

/** The chat before this task, as real turns rather than a summary of them. */
export function priorTurnMessages(turns: PriorTurn[] | undefined): OllamaMessage[] {
  return (turns ?? [])
    .filter((turn) => turn.text.trim())
    .slice(-MAX_PRIOR_TURNS)
    .map((turn) => ({
      role: turn.role,
      content: clipTurn(turn.text.trim()),
    }));
}

/**
 * Keeps the carried transcript inside its share of the window.
 *
 * Drops from the front, because the newest rounds are the ones the current
 * request continues — with one exception: the task's opening request is
 * pinned. It is the shortest message in the transcript and the only one
 * stating what the whole task is for, and dropping it is how a long tool
 * loop ends up confidently finishing the wrong job.
 */
export function capHistory(
  messages: OllamaMessage[],
  maxTokens: number
): OllamaMessage[] {
  const pinned = messages[0]?.role === "user" ? messages.slice(0, 1) : [];
  let budget = maxTokens - messageTokens(pinned[0]);
  const kept: OllamaMessage[] = [];
  for (let i = messages.length - 1; i >= pinned.length; i--) {
    const cost = messageTokens(messages[i]);
    if (cost > budget) break;
    budget -= cost;
    kept.unshift(messages[i]!);
  }
  // A tool result whose calling message was just dropped is an answer to a
  // question the transcript no longer contains; some chat templates reject
  // the pair outright, and every model reads it as noise.
  while (kept.length > 0 && kept[0]!.role === "tool") kept.shift();
  if (kept.length === messages.length - pinned.length) return messages;
  return [...pinned, ...kept];
}

function messageTokens(message: OllamaMessage | undefined): number {
  if (!message) return 0;
  return approxTokens(
    (message.content ?? "") +
      (message.tool_calls ? safeJson(message.tool_calls) : "")
  );
}

/**
 * Keeps both ends of a long turn: the head carries the subject, the tail
 * carries the conclusion a follow-up is usually reacting to.
 */
function clipTurn(text: string): string {
  if (text.length <= MAX_PRIOR_TURN_CHARS) return text;
  const marker = "\n… [middle omitted] …\n";
  const available = MAX_PRIOR_TURN_CHARS - marker.length;
  const head = Math.floor(available * 0.4);
  return `${text.slice(0, head)}${marker}${text.slice(-(available - head))}`;
}

function userMessage(prompt: string, images?: ImageAttachment[]): OllamaMessage {
  const message: OllamaMessage = { role: "user", content: prompt };
  if (images && images.length > 0) {
    message.images = images.map((image) => image.data);
  }
  return message;
}

async function runTool(
  tools: ToolRegistry,
  name: string,
  input: unknown,
  taskId: string,
  signal: AbortSignal
): Promise<string> {
  try {
    const result = await tools.run(name, input, taskId, signal);
    return shapeToolOutput(name, result);
  } catch (error) {
    if (signal.aborted) throw error;
    return `Error: ${String(error)}`;
  }
}

function normalizeToolArguments(args: unknown): unknown {
  if (typeof args !== "string") return args ?? {};
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return {};
  }
}

/** The offered schemas, in declaration order, filtered by name if asked. */
export function atelierToolsFor(names: string[] | undefined): JsonSchema[] {
  if (!names) return ATELIER_TOOLS;
  const wanted = new Set(names);
  return ATELIER_TOOLS.filter((schema) => wanted.has(toolNameOf(schema)));
}

function toolNameOf(schema: JsonSchema): string {
  const fn = schema.function as { name?: string } | undefined;
  return fn?.name ?? "";
}

/**
 * One streamed /api/chat round: text deltas reach `onDelta` as they arrive,
 * tool calls are accumulated across chunks, and the assembled assistant
 * message is returned for the transcript. The timeout is idle-based — it
 * resets on every chunk — so a slow-but-alive generation is never killed,
 * while a stalled connection still fails within IDLE_TIMEOUT_MS.
 */
async function ollamaChatStreaming(
  model: string,
  target: OllamaTarget,
  messages: OllamaMessage[],
  tools: JsonSchema[],
  numCtx: number,
  /** Omit for models without the capability; /api/chat rejects it there. */
  think: boolean | undefined,
  signal: AbortSignal,
  onDelta: (delta: string) => void,
  onThinking?: (delta: string) => void
): Promise<OllamaMessage> {
  const abort = new AbortController();
  const onOuterAbort = () => abort.abort();
  signal.addEventListener("abort", onOuterAbort, { once: true });
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abort.abort(), IDLE_TIMEOUT_MS);
  };

  try {
    armIdle();
    const response = await fetch(`${ollamaHost(target)}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(target) },
      body: JSON.stringify({
        model,
        messages,
        tools,
        stream: true,
        ...(think !== undefined ? { think } : {}),
        options: { num_ctx: numCtx },
      }),
      signal: abort.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      if (isOllamaSubscriptionRequired(response.status, detail)) {
        setModelSubscriptionRequired(target, model, true);
        throw new Error(
          `Ollama model "${model}" requires a subscription. ` +
            "Choose a Free-access model or upgrade the Ollama account."
        );
      }
      throw new Error(
        `Ollama ${response.status} for agent model "${model}": ${detail.slice(0, 300)}`
      );
    }
    if (!response.body) throw new Error("Ollama returned no response body");

    const assembled: OllamaMessage = { role: "assistant", content: "" };
    const toolCalls: OllamaToolCall[] = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const chunk = JSON.parse(trimmed) as OllamaChatResponse & {
        done?: boolean;
      };
      if (chunk.error) throw new Error(`Ollama error: ${chunk.error}`);
      const delta = chunk.message?.content ?? "";
      if (delta) {
        assembled.content += delta;
        onDelta(delta);
      }
      // The hidden pass, live. Some models expose their internal channel
      // markers here as well; those are transport syntax, not user-facing
      // thought, so keep them out of the shared thinking surface.
      const thinking = cleanOllamaThinking(chunk.message?.thinking ?? "");
      if (thinking) onThinking?.(thinking);
      if (chunk.message?.tool_calls) toolCalls.push(...chunk.message.tool_calls);
      // The final chunk carries the run's token counts.
      if (chunk.done) recordResponseUsage(target, chunk);
    };

    for (;;) {
      const { done, value } = await reader.read();
      armIdle();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    }
    if (buffer.trim()) handleLine(buffer);

    if (toolCalls.length > 0) assembled.tool_calls = toolCalls;
    if (target === "ollama-cloud") {
      setModelSubscriptionRequired(target, model, false);
    }
    return assembled;
  } catch (error) {
    // Name the actual failure: a bare AbortError reads as a user cancel
    // when it was really the endpoint going quiet.
    if (!signal.aborted && abort.signal.aborted) {
      throw new Error(
        `Ollama stream for "${model}" stalled — no data for ${IDLE_TIMEOUT_MS / 1000}s`
      );
    }
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    signal.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * Removes Harmony-style control syntax that a few Ollama reasoning models
 * include in their `thinking` field. The labels are protocol routing
 * metadata; displaying them made the activity rail read as repeated
 * "`<|channel|>thought`" instead of the model's actual reasoning.
 */
export function cleanOllamaThinking(value: string): string {
  return value.replace(
    /<\|channel\|>\s*(?:analysis|commentary|final|thought)?[ \t]*|<\/?channel>\s*(?:analysis|commentary|final|thought)?[ \t]*/gi,
    ""
  );
}

function authHeaders(target: OllamaTarget): Record<string, string> {
  const key = ollamaApiKey(target);
  return key ? { authorization: `Bearer ${key}` } : {};
}

function recordResponseUsage(target: OllamaTarget, body: OllamaChatResponse): void {
  // The Cloud section must never be inflated by requests served by the local
  // daemon, even when that daemon happens to proxy a cloud-tagged model.
  if (target !== OLLAMA_CLOUD) return;
  try {
    recordCloudUsage({
      prompt_eval_count: body.prompt_eval_count,
      eval_count: body.eval_count,
      total_duration: body.total_duration,
      createdAt: Date.now(),
    });
  } catch {
    // usage metering must not break a task
  }
}

const ATELIER_TOOLS = [
  tool("read_file", "Read a text file from the workspace.", {
    path: stringSchema("Workspace-relative file path"),
    offset: numberSchema("1-based line number to start reading from"),
    limit: numberSchema("Max number of lines to return"),
  }),
  tool("read_many_files", "Read up to 20 workspace files or line slices in one call.", {
    files: arraySchema({
      type: "object",
      properties: {
        path: stringSchema("Workspace-relative file path"),
        offset: numberSchema("1-based line number to start reading from"),
        limit: numberSchema("Max number of lines to return"),
      },
      required: ["path"],
    }),
  }, ["files"]),
  tool("write_file", "Create a NEW file, or fully replace one whose content " +
    "is genuinely being thrown away. To change part of an existing file use " +
    "replace_code instead — a blocking hook refuses a rewrite that mostly " +
    "restates the file it replaces.", {
    path: stringSchema("Workspace-relative file path"),
    content: stringSchema("Full new file content"),
  }, ["path", "content"]),
  tool("replace_code", "Replace an exact string in a file. The default way " +
    "to edit an existing file. Copy oldString verbatim out of a read_file " +
    "result — same indentation, same spacing — instead of retyping it from " +
    "memory, and include enough lines that it appears only once.", {
    path: stringSchema("Workspace-relative file path"),
    oldString: stringSchema("Exact text as it appears in the file"),
    newString: stringSchema("Replacement string"),
    replaceAll: booleanSchema("Replace every match"),
  }, ["path", "oldString", "newString"]),
  tool("replace_many", "Apply exact replacements across one or more files in " +
    "one call. Each edit is applied on its own, so one bad oldString does " +
    "not discard the others.", {
    edits: arraySchema({
      type: "object",
      properties: {
        path: stringSchema("Workspace-relative file path"),
        oldString: stringSchema("Exact text as it appears in the file"),
        newString: stringSchema("Replacement string"),
        replaceAll: booleanSchema("Replace every match"),
      },
      required: ["path", "oldString", "newString"],
    }),
  }, ["edits"]),
  tool("search_workspace", "Find files relevant to a query using the live knowledge index.", {
    query: stringSchema("Natural-language or symbol query"),
    glob: stringSchema("Optional glob filter"),
    maxResults: numberSchema("Max results"),
  }, ["query"]),
  tool("search_text", "Fast literal or regex text search over non-ignored workspace files.", {
    query: stringSchema("Literal text or regex pattern"),
    glob: stringSchema("Optional glob filter"),
    maxResults: numberSchema("Max results"),
    regex: booleanSchema("Treat query as a regex"),
  }, ["query"]),
  tool("list_dir", "List files and directories at a workspace-relative path.", {
    path: stringSchema("Workspace-relative directory path"),
  }),
  tool("git", "Run a git operation in the workspace repository.", {
    action: enumSchema([
      "status",
      "log",
      "diff",
      "stage",
      "unstage",
      "commit",
      "branches",
      "checkout",
    ]),
    paths: arraySchema(stringSchema("Workspace-relative path")),
    path: stringSchema("Single file to diff"),
    staged: booleanSchema("Diff the staged version"),
    ref: stringSchema("Ref to diff against, or branch for checkout"),
    message: stringSchema("Commit message"),
    create: booleanSchema("Create branch on checkout"),
    maxCount: numberSchema("Max commits for log"),
  }, ["action"]),
  tool("retrieve_knowledge", "Retrieve scored code chunks from the workspace knowledge index.", {
    query: stringSchema("Natural-language or symbol query"),
    k: numberSchema("Max chunks"),
    pathGlob: stringSchema("Optional path glob"),
  }, ["query"]),
  tool("query_knowledge_graph", "Query imports, call edges, symbols, or features.", {
    scope: enumSchema(["file", "symbol", "feature", "workspace"]),
    target: stringSchema("Path, symbol name, or slug"),
    depth: numberSchema("Neighborhood depth"),
  }, ["scope"]),
  tool("search_symbols", "Fuzzy-search indexed symbols by name.", {
    query: stringSchema("Symbol name or fragment"),
    limit: numberSchema("Max results"),
  }, ["query"]),
  tool("impact_of_edit", "Before editing a place, check who uses it.", {
    path: stringSchema("Workspace-relative file path"),
    line: numberSchema("1-based line number"),
    symbol: stringSchema("Symbol name"),
  }, ["path"]),
  tool("analyze_impact", "Find what depends on whole files or symbols.", {
    files: arraySchema(stringSchema("Workspace-relative file path")),
    symbols: arraySchema(stringSchema("Symbol name")),
    depth: numberSchema("Ripple depth"),
  }),
  tool("set_plan", "Create the execution timeline before editing. If new " +
    "necessary work is discovered later, call set_plan again with ONLY the " +
    "new steps; they append and cannot replace existing steps. Execute every " +
    "returned id in order with update_plan_step.", {
    goal: stringSchema("One line: what this task delivers"),
    steps: arraySchema({
      type: "object",
      properties: {
        title: stringSchema("Short imperative step"),
        detail: stringSchema("One line of extra context, when needed"),
        files: arraySchema(stringSchema("Workspace-relative files this step touches")),
      },
      required: ["title"],
    }),
  }, ["goal", "steps"]),
  tool("update_plan_step", "Start and explicitly finish the current timeline " +
    "step. Order is enforced and only done clears the final-report gate.", {
    stepId: stringSchema("Plan step id"),
    status: enumSchema([
      "pending",
      "in-progress",
      "done",
      "failed",
      "cancelled",
      "skipped",
    ]),
    note: stringSchema("Optional short note"),
  }, ["stepId", "status"]),
  tool("save_lesson", "Persist a small reusable project lesson.", {
    title: stringSchema("One-line title"),
    lesson: stringSchema("Distilled lesson"),
    kind: enumSchema(["bug-fix", "gotcha", "pattern", "preference"]),
    symbols: arraySchema(stringSchema("Symbol name")),
    files: arraySchema(stringSchema("Workspace-relative file path")),
  }, ["title", "lesson"]),
  tool("preview_review", "Debug a local Page preview in headless Chromium. Returns " +
    "status/decision, chronological DevTools console, page errors, failed HTTP " +
    "requests, DOM/layout, and screenshots. Obey decision: unavailable = ask user " +
    "to start/reopen preview and stop without retrying or starting a server; " +
    "issues = report evidence then fix if allowed or skip; failed = report and skip.", {
    url: stringSchema("The local http(s) URL shown in Page preview"),
  }, ["url"]),
  tool("run_terminal", "Run a shell command in the workspace.", {
    command: stringSchema("PowerShell command line"),
    cwd: stringSchema("Workspace-relative working directory"),
    timeoutMs: numberSchema("Timeout in milliseconds"),
  }, ["command"]),
];

function tool(
  name: string,
  description: string,
  properties: Record<string, JsonSchema>,
  required: string[] = []
): JsonSchema {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
      },
    },
  };
}

function stringSchema(description: string): JsonSchema {
  return { type: "string", description };
}

function numberSchema(description: string): JsonSchema {
  return { type: "number", description };
}

function booleanSchema(description: string): JsonSchema {
  return { type: "boolean", description };
}

function enumSchema(values: string[]): JsonSchema {
  return { type: "string", enum: values };
}

function arraySchema(items: JsonSchema): JsonSchema {
  return { type: "array", items };
}
