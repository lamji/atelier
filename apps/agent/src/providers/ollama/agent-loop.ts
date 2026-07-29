import type { ImageAttachment } from "@atelier/protocol";
import type { ToolRegistry } from "../../tools/registry.js";
import { shapeToolOutput } from "../../context/tool-output/index.js";
import type { OllamaTarget } from "../model-routing.js";
import { ollamaApiKey, ollamaHost, resolveNumCtx } from "./client.js";
import { recordUsage } from "./usage.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TURNS = 30;

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
   * Narrows the tool surface offered to the model. Undefined offers every
   * Atelier tool; a list is how direct mode (system knowledge off) keeps
   * the knowledge tools out of the loop entirely.
   */
  toolNames?: string[];
  taskId: string;
  signal: AbortSignal;
  emitText: (delta: string) => void;
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

  const offered = toolsFor(opts.toolNames);
  const target = opts.target ?? "ollama-cloud";
  // Sized from the model, once per run. The tool loop replays every result
  // on every turn, so this is the number that decides whether the rules and
  // the assembled context survive to the end of the task.
  const numCtx = await resolveNumCtx(opts.model, target);

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await ollamaChatWithTools(
      opts.model,
      target,
      messages,
      offered,
      numCtx,
      opts.signal
    );
    const message = response.message ?? { role: "assistant", content: "" };
    recordResponseUsage(response);
    messages.push(message);

    const calls = message.tool_calls?.filter((call) => call.function?.name) ?? [];
    if (calls.length === 0) {
      const content = message.content ?? "";
      if (content) {
        text += content;
        opts.emitText(content);
      }
      return text;
    }

    if (message.content) {
      text += message.content;
      opts.emitText(message.content);
    }

    for (const call of calls) {
      const name = call.function?.name;
      if (!name) continue;
      const input = normalizeToolArguments(call.function?.arguments);
      const content = await runTool(opts.tools, name, input, opts.taskId, opts.signal);
      messages.push({ role: "tool", tool_name: name, content });
    }
  }

  throw new Error(`Ollama agent loop exceeded ${MAX_TURNS} turns`);
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
function toolsFor(names: string[] | undefined): JsonSchema[] {
  if (!names) return ATELIER_TOOLS;
  const wanted = new Set(names);
  return ATELIER_TOOLS.filter((schema) => wanted.has(toolNameOf(schema)));
}

function toolNameOf(schema: JsonSchema): string {
  const fn = schema.function as { name?: string } | undefined;
  return fn?.name ?? "";
}

async function ollamaChatWithTools(
  model: string,
  target: OllamaTarget,
  messages: OllamaMessage[],
  tools: JsonSchema[],
  numCtx: number,
  signal: AbortSignal
): Promise<OllamaChatResponse> {
  const response = await fetchWithTimeout(`${ollamaHost(target)}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(target) },
    body: JSON.stringify({
      model,
      messages,
      tools,
      stream: false,
      options: { num_ctx: numCtx },
    }),
    signal,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Ollama ${response.status} for agent model "${model}": ${detail.slice(0, 300)}`
    );
  }

  const body = (await response.json()) as OllamaChatResponse;
  if (body.error) throw new Error(`Ollama error: ${body.error}`);
  return body;
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

interface TimedRequest extends RequestInit {
  timeoutMs: number;
}

async function fetchWithTimeout(
  url: string,
  { timeoutMs, signal, ...init }: TimedRequest
): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const onOuterAbort = () => abort.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: abort.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
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
    "to edit an existing file.", {
    path: stringSchema("Workspace-relative file path"),
    oldString: stringSchema("Exact old string"),
    newString: stringSchema("Replacement string"),
    replaceAll: booleanSchema("Replace every match"),
  }, ["path", "oldString", "newString"]),
  tool("replace_many", "Apply exact replacements across one or more files in one call.", {
    edits: arraySchema({
      type: "object",
      properties: {
        path: stringSchema("Workspace-relative file path"),
        oldString: stringSchema("Exact old string"),
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
