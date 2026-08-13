import type { ImageAttachment } from "@atelier/protocol";
import type { ToolRegistry } from "../../tools/registry.js";
import { shapeToolOutput } from "../../context/tool-output/index.js";
import type { OllamaTarget } from "../model-routing.js";
import { setModelSubscriptionRequired } from "../credentials.js";
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
import { recordUsage } from "./usage.js";

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

type JsonSchema = Record<string, unknown>;

interface OllamaToolCall {
  function?: {
    name?: string;
    arguments?: unknown;
  };
}

interface OllamaMessage {
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

export interface OllamaAgentLoopOptions {
  model: string;
  /** Which endpoint serves this model — the daemon here, or the cloud. */
  target?: OllamaTarget;
  system: string;
  prompt: string;
  images?: ImageAttachment[];
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
  /** Thinking deltas, for the same live surface Claude's thinking uses. */
  emitThinking?: (delta: string) => void;
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
  const messages: OllamaMessage[] = [
    { role: "system", content: opts.system },
    userMessage(opts.prompt, opts.images),
  ];
  let text = "";
  /** Failing calls, by signature — see noteFailure. */
  const failures = new Map<string, number>();
  // Ollama does not have the SDK's persistent working-set awareness. Keep a
  // small, per-turn proof ledger so stale retrieval or session summaries can
  // inform investigation but can never authorize a blind patch.
  const grounding: EditGrounding = {
    required: true,
    discovered: false,
    readPaths: new Set<string>(),
  };
  const callDeps: ToolCallDeps = { ...opts, grounding };

  const offered = atelierToolsFor(opts.toolNames);
  const target = opts.target ?? "ollama-cloud";
  // Sized from the model, once per run. The tool loop replays every result
  // on every turn, so this is the number that decides whether the rules and
  // the assembled context survive to the end of the task.
  const numCtx = await resolveNumCtx(opts.model, target);
  // Only sent to models that advertise the capability — /api/chat rejects
  // `think` on anything else. High effort opts in; the default is OFF,
  // because the hidden pass re-runs before every tool round and is the
  // difference between an Ollama turn and a Claude turn taking the same
  // path in minutes versus seconds.
  const think = (await supportsThinking(opts.model, target))
    ? ["high", "xhigh", "max", "ultra"].includes(opts.effort ?? "")
    : undefined;

  for (let turn = 0; turn < MAX_TOOL_ROUNDS; turn++) {
    // Streamed, and the deltas go straight to the UI as they arrive — the
    // same behavior the Claude path has always had. Before this the whole
    // response was buffered, so an Ollama turn read as "nothing, nothing,
    // everything" however fast the model actually was.
    const message = await ollamaChatStreaming(
      opts.model,
      target,
      messages,
      groundedToolsFor(offered, grounding),
      numCtx,
      think,
      opts.signal,
      (delta) => {
        text += delta;
        opts.emitText(delta);
      },
      opts.emitThinking
    );
    messages.push(message);

    const calls = message.tool_calls?.filter((call) => call.function?.name) ?? [];
    if (calls.length === 0) return text;

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
    named.forEach((call, i) => {
      messages.push({
        role: "tool",
        tool_name: call.name,
        content: noteFailure(failures, call, results[i]!),
      });
    });
  }

  // This budget belongs only to this invocation; the next follow-up calls
  // runOllamaAgentLoop again with a new transcript and starts at round zero.
  // If this prompt used every tool round, force one tool-free completion so
  // the user gets a useful handoff instead of a misleading red loop error.
  messages.push({ role: "system", content: TOOL_BUDGET_FINAL_INSTRUCTION });
  await ollamaChatStreaming(
    opts.model,
    target,
    messages,
    [],
    numCtx,
    think,
    opts.signal,
    (delta) => {
      text += delta;
      opts.emitText(delta);
    },
    opts.emitThinking
  );
  return text;
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
 * out of the schema until this turn has both located live code and read it.
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
  if (grounding.discovered && grounding.readPaths.size > 0) return tools;
  return tools.filter((schema) => !MUTATION_TOOLS.has(toolNameOf(schema)));
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
    const result = await runTool(
      opts.tools,
      name,
      input,
      opts.taskId,
      opts.signal
    );
    recordGrounding(opts.grounding, name, input, result);
    return result;
  }
  const edits = editsOf(name, input);
  // Arguments this module does not recognise stay the registry's problem;
  // its schema errors are better than anything guessed here.
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
    results.push(await runEdit(edit, opts));
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
  if (name === "read_file" && typeof value?.path === "string") {
    grounding.readPaths.add(pathKey(value.path));
    return;
  }
  if (name !== "read_many_files" || !Array.isArray(value?.files)) return;
  for (const entry of value.files) {
    const path = (entry as { path?: unknown })?.path;
    if (typeof path !== "string") continue;
    // The compact read-many shaper emits a header only for successful reads.
    if (result.includes(`### ${path}`)) grounding.readPaths.add(pathKey(path));
  }
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

/** Repair, run, and on a miss answer with something actionable. */
async function runEdit(
  edit: EditInput,
  opts: ToolCallDeps
): Promise<string> {
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
      // The hidden pass, live. Dropping it (the old behavior) made a
      // reasoning model look hung for exactly as long as it was thinking.
      const thinking = chunk.message?.thinking ?? "";
      if (thinking) onThinking?.(thinking);
      if (chunk.message?.tool_calls) toolCalls.push(...chunk.message.tool_calls);
      // The final chunk carries the run's token counts.
      if (chunk.done) recordResponseUsage(chunk);
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

function authHeaders(target: OllamaTarget): Record<string, string> {
  const key = ollamaApiKey(target);
  return key ? { authorization: `Bearer ${key}` } : {};
}

function recordResponseUsage(body: OllamaChatResponse): void {
  try {
    recordUsage({
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
  tool("set_plan", "Publish the plan for this task — the checklist the user " +
    "watches while you work. Call it ONCE, before you start changing " +
    "things, for anything beyond a single trivial edit. Returns the step " +
    "ids — drive them with update_plan_step as you go.", {
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
  tool("update_plan_step", "Report progress on the current task plan.", {
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
