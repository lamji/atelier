/**
 * Isolated Ollama backend: talks to Ollama over its own HTTP API. No Claude
 * Agent SDK, no CLI subprocess, no translation proxy. Tool-less one-shot
 * calls use ollamaChat(); the main coding loop uses agent-loop.ts with the
 * same /api/chat backend plus Ollama tool calls.
 *
 * Works against either endpoint, because both speak the same API:
 *
 *  - the local daemon (127.0.0.1:11434). Once `ollama signin` has stored a
 *    device key, cloud models show up here too, as "-cloud" tags that the
 *    daemon proxies upstream. No API key needed on our side.
 *  - Ollama Cloud directly (https://ollama.com), authenticated with an API
 *    key from ollama.com/settings/keys. Set OLLAMA_API_KEY and the host
 *    switches to cloud on its own.
 */

import { ollamaConfig } from "../credentials.js";
import { recordUsage } from "./usage.js";

const DEFAULT_HOST = "http://127.0.0.1:11434";
const CLOUD_HOST = "https://ollama.com";

/** Local models are slower than a hosted call, and a cold load is slower still. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Ollama defaults num_ctx to a couple of thousand tokens and silently drops
 * whatever overflows — with RAG context attached that would quietly truncate
 * the prompt rather than fail, so we always ask for a real window.
 */
const DEFAULT_NUM_CTX = 8192;

export interface OllamaModel {
  /** Tag as Ollama knows it, e.g. "qwen2.5-coder:7b". */
  name: string;
  /** Parameter count / quantization, when the daemon reports them. */
  parameterSize?: string;
  quantization?: string;
}

export interface OllamaChatOptions {
  model: string;
  prompt: string;
  system?: string;
  signal?: AbortSignal;
  /** Ask the daemon to constrain output to valid JSON. */
  json?: boolean;
  numCtx?: number;
  timeoutMs?: number;
}

/**
 * API key for Ollama Cloud. Settings wins over the environment: a key typed
 * into the UI is the explicit choice, and env stays as a headless fallback.
 */
export function ollamaApiKey(): string | undefined {
  return ollamaConfig().apiKey || process.env.OLLAMA_API_KEY?.trim() || undefined;
}

/**
 * Base URL. Honors Ollama's own OLLAMA_HOST so an existing install works
 * untouched — that var is commonly a bare "host:port", which needs a scheme
 * before fetch will take it. With no host set, an API key means the user is
 * pointing at Ollama Cloud, so that becomes the default instead of local.
 */
export function ollamaHost(): string {
  const raw = ollamaConfig().host || process.env.OLLAMA_HOST?.trim();
  if (!raw) return ollamaApiKey() ? CLOUD_HOST : DEFAULT_HOST;
  const withScheme = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

/** True when calls go to Ollama Cloud rather than a daemon on this machine. */
export function isCloudHost(): boolean {
  return new URL(ollamaHost()).hostname.endsWith("ollama.com");
}

/** Bearer auth is sent whenever a key exists; the local daemon ignores it. */
function authHeaders(): Record<string, string> {
  const key = ollamaApiKey();
  return key ? { authorization: `Bearer ${key}` } : {};
}

/**
 * Models the daemon currently has pulled. Returns [] when Ollama is not
 * running — a missing daemon is the normal case for most users, not an
 * error worth surfacing, so the picker simply shows no Ollama rows.
 */
export async function listOllamaModels(): Promise<OllamaModel[]> {
  // Escape hatch: /api/tags is a "models I have" endpoint, so a cloud
  // account may legitimately list nothing there. Naming tags explicitly
  // keeps the picker usable without hardcoding a roster in the source.
  const pinned = process.env.OLLAMA_MODELS?.trim();
  if (pinned) {
    return pinned
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => ({ name }));
  }
  try {
    const response = await fetchWithTimeout(`${ollamaHost()}/api/tags`, {
      method: "GET",
      headers: authHeaders(),
      timeoutMs: 10_000,
    });
    if (!response.ok) return [];
    const body = (await response.json()) as {
      models?: Array<{
        name?: string;
        details?: { parameter_size?: string; quantization_level?: string };
      }>;
    };
    return (body.models ?? [])
      .filter((m): m is { name: string; details?: Record<string, string> } =>
        typeof m.name === "string"
      )
      .map((m) => ({
        name: m.name,
        parameterSize: m.details?.parameter_size,
        quantization: m.details?.quantization_level,
      }));
  } catch {
    return [];
  }
}

/** True when a daemon answered — used to explain an empty roster. */
export async function ollamaReachable(): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(`${ollamaHost()}/api/tags`, {
      method: "GET",
      headers: authHeaders(),
      timeoutMs: 10_000,
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * One tool-less turn. Non-streaming: every caller here wants the finished
 * text (a commit message, a JSON summary), never deltas.
 */
export async function ollamaChat(opts: OllamaChatOptions): Promise<string> {
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.prompt });

  const response = await fetchWithTimeout(`${ollamaHost()}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      model: opts.model,
      messages,
      stream: false,
      ...(opts.json ? { format: "json" } : {}),
      options: { num_ctx: opts.numCtx ?? DEFAULT_NUM_CTX },
    }),
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Ollama rejected the credentials for "${opts.model}" (${response.status}). ` +
          (ollamaApiKey()
            ? "Check OLLAMA_API_KEY at ollama.com/settings/keys."
            : "Cloud models need OLLAMA_API_KEY, or a signed-in local daemon.")
      );
    }
    throw new Error(
      `Ollama ${response.status} for model "${opts.model}": ${detail.slice(0, 300)}`
    );
  }

  const body = (await response.json()) as {
    message?: { content?: string };
    error?: string;
    prompt_eval_count?: number;
    eval_count?: number;
    total_duration?: number;
  };
  if (body.error) throw new Error(`Ollama error: ${body.error}`);

  // Ollama has no usage endpoint, so the per-response counters are the only
  // measure of what we spend. Metering must never break a completion.
  try {
    recordUsage({
      prompt_eval_count: body.prompt_eval_count,
      eval_count: body.eval_count,
      total_duration: body.total_duration,
      createdAt: Date.now(),
    });
  } catch {
    // metering is best-effort
  }

  return body.message?.content ?? "";
}

interface TimedRequest extends RequestInit {
  timeoutMs: number;
}

/**
 * fetch with a deadline, chained to any caller-supplied signal so a
 * cancelled task tears the HTTP request down too.
 */
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
