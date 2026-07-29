import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ReasoningEffort } from "@atelier/protocol";
import { ollamaChat } from "./ollama/client.js";
import {
  codexModelName,
  isCodexModel,
  ollamaModelName,
  ollamaTargetOf,
} from "./model-routing.js";
import { runCodexExec } from "./codex/client.js";

/**
 * The three tool-less call sites in the agent (pipeline stage calls, git
 * drafts, feature summaries) all want the same thing: one turn, a system
 * prompt, a user prompt, finished text back. Routing them through here is
 * what makes "pick an Ollama model" work — the prompt each caller builds,
 * including everything RAG, knowledge and impact put in it, is untouched.
 */

/** Tools are off for every one-shot call — these are pure completions. */
const DISABLED_BUILTINS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Task",
  "TodoWrite",
  "NotebookEdit",
];

export interface OneShotOptions {
  /** The user's selected model; an "ollama/" id routes to the daemon. */
  model?: string;
  /** Claude model to use when the selection isn't an Ollama one. */
  claudeFallback: string;
  system: string;
  prompt: string;
  cwd?: string;
  signal?: AbortSignal;
  effort?: ReasoningEffort;
  /** Caller wants strict JSON — Ollama can enforce it at the daemon. */
  json?: boolean;
}

export async function runOneShot(opts: OneShotOptions): Promise<string> {
  const ollama = ollamaTargetOf(opts.model);
  if (ollama) {
    return ollamaChat({
      model: ollamaModelName(opts.model as string),
      target: ollama,
      system: opts.system,
      prompt: opts.prompt,
      signal: opts.signal,
      json: opts.json,
    });
  }
  if (isCodexModel(opts.model)) {
    return runCodexExec({
      cwd: opts.cwd ?? process.cwd(),
      model: codexModelName(opts.model as string),
      prompt: `${opts.system}\n\n${opts.prompt}`,
      signal: opts.signal ?? new AbortController().signal,
      sandbox: "read-only",
      effort: opts.effort,
    });
  }
  return runClaudeOneShot(opts);
}

async function runClaudeOneShot(opts: OneShotOptions): Promise<string> {
  const stream = query({
    prompt: opts.prompt,
    options: {
      systemPrompt: opts.system,
      model: opts.claudeFallback,
      maxTurns: 1,
      disallowedTools: DISABLED_BUILTINS,
      strictMcpConfig: true,
      settingSources: [],
      ...(opts.signal ? { abortController: controllerFor(opts.signal) } : {}),
    },
  });
  let text = "";
  for await (const message of stream) {
    const m = message as Record<string, unknown>;
    if (m.type === "result" && typeof m.result === "string") text = m.result;
  }
  return text;
}

/**
 * The SDK takes an AbortController, callers here hold a signal. Bridging
 * keeps one cancellation story across both backends.
 */
function controllerFor(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}
