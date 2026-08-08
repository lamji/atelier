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

import { ollamaConfig, OLLAMA_LOCAL } from "../credentials.js";
import type { OllamaTarget } from "../model-routing.js";
import { recordUsage } from "./usage.js";

const DEFAULT_HOST = "http://127.0.0.1:11434";
const CLOUD_HOST = "https://ollama.com";

/** Local models are slower than a hosted call, and a cold load is slower still. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Ollama defaults num_ctx to a couple of thousand tokens and silently drops
 * whatever overflows — with RAG context attached that would quietly truncate
 * the prompt rather than fail, so we always ask for a real window.
 *
 * This is the floor, used only when the daemon will not say what the model
 * supports. The real value comes from the model itself (see resolveNumCtx):
 * a knowledge-engine turn spends ~1.6k tokens on rules, ~0.7k on tool
 * schemas and up to 3.5k on assembled context before the model has read a
 * single file, so 8k left almost nothing for the tool loop — and what
 * overflowed was dropped in silence.
 */
const DEFAULT_NUM_CTX = 8192;

/**
 * Ceiling on the window we will ask for.
 *
 * The KV cache is real memory: a 128k window on an 8B model costs several
 * GB beyond the weights, and asking for more than the machine has makes the
 * daemon spill to CPU and crawl — a worse failure than truncation because
 * it looks like the model is merely slow. 32k fits the pipeline plus a long
 * tool loop. `OLLAMA_NUM_CTX` overrides it for a machine with the memory.
 */
const MAX_NUM_CTX = 32_768;

/** Resolved windows, per endpoint+model. /api/show is a subprocess-level probe. */
const contextWindows = new Map<string, number>();

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
  /** Which endpoint to call. Defaults to the hosted one. */
  target?: OllamaTarget;
  /**
   * Base64 image payloads (no data: prefix) for the user message. Ollama
   * takes them on the message itself; a text-only model simply ignores them.
   */
  images?: string[];
}

/**
 * API key for one endpoint.
 *
 * The local target never borrows the cloud key or the environment: it is a
 * daemon on this machine, and a key that leaked into those requests would
 * only be a secret sent somewhere it was not meant for. Its own entry can
 * still carry one, for a daemon reached over a LAN behind a proxy.
 */
export function ollamaApiKey(
  target: OllamaTarget = "ollama-cloud"
): string | undefined {
  if (target === OLLAMA_LOCAL) return ollamaConfig(OLLAMA_LOCAL).apiKey || undefined;
  return ollamaConfig().apiKey || process.env.OLLAMA_API_KEY?.trim() || undefined;
}

/**
 * Base URL for one endpoint. Honors Ollama's own OLLAMA_HOST so an existing
 * install works untouched — that var is commonly a bare "host:port", which
 * needs a scheme before fetch will take it.
 *
 * The two targets differ in what "unset" means. For the hosted one, an API
 * key implies Ollama Cloud. The local one is defined by being local: it
 * falls back to the daemon on this machine and never to the cloud, whatever
 * keys happen to be stored.
 */
export function ollamaHost(target: OllamaTarget = "ollama-cloud"): string {
  const configured = ollamaConfig(target).host;
  const raw = configured || process.env.OLLAMA_HOST?.trim();
  if (!raw) {
    if (target === OLLAMA_LOCAL) return DEFAULT_HOST;
    return ollamaApiKey(target) ? CLOUD_HOST : DEFAULT_HOST;
  }
  const withScheme = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

/** True when calls go to Ollama Cloud rather than a daemon on this machine. */
export function isCloudHost(target: OllamaTarget = "ollama-cloud"): boolean {
  return new URL(ollamaHost(target)).hostname.endsWith("ollama.com");
}

/** Bearer auth is sent whenever a key exists; the local daemon ignores it. */
function authHeaders(target: OllamaTarget = "ollama-cloud"): Record<string, string> {
  const key = ollamaApiKey(target);
  return key ? { authorization: `Bearer ${key}` } : {};
}

/**
 * Models the daemon currently has pulled. Returns [] when Ollama is not
 * running — a missing daemon is the normal case for most users, not an
 * error worth surfacing, so the picker simply shows no Ollama rows.
 */
export async function listOllamaModels(
  target: OllamaTarget = "ollama-cloud"
): Promise<OllamaModel[]> {
  // Escape hatch: /api/tags is a "models I have" endpoint, so a cloud
  // account may legitimately list nothing there. Naming tags explicitly
  // keeps the picker usable without hardcoding a roster in the source.
  // Local reads the daemon, which is authoritative about what is pulled.
  const pinned =
    target === OLLAMA_LOCAL ? "" : process.env.OLLAMA_MODELS?.trim();
  if (pinned) {
    return pinned
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => ({ name }));
  }
  try {
    const response = await fetchWithTimeout(`${ollamaHost(target)}/api/tags`, {
      method: "GET",
      headers: authHeaders(target),
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

/**
 * The context window to ask for when running `model`.
 *
 * Ollama does not size this from the model — it applies its own small
 * default and silently discards whatever does not fit, so the caller has to
 * name a number. Asking the daemon what the model actually supports is the
 * only way to get that right for a roster the user controls: an 8B gemma
 * reports 131072, a small embedding model reports 2048, and one hardcoded
 * constant is wrong for both.
 *
 * Cached per model: /api/show reads the manifest, and this is called on
 * every turn of the tool loop.
 */
export async function resolveNumCtx(
  model: string,
  target: OllamaTarget = "ollama-cloud"
): Promise<number> {
  const key = `${target}:${model}`;
  const cached = contextWindows.get(key);
  if (cached) return cached;

  const reported = await modelContextLength(model, target);
  // A model that does not report its window keeps the floor, not the cap:
  // asking for more than a model has is how a load fails outright.
  const value = reported ? Math.min(reported, numCtxCap()) : DEFAULT_NUM_CTX;
  contextWindows.set(key, value);
  return value;
}

function numCtxCap(): number {
  const raw = Number(process.env.OLLAMA_NUM_CTX?.trim());
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : MAX_NUM_CTX;
}

/**
 * The model's own context length, from its manifest. The key is
 * family-scoped ("gemma4.context_length", "llama.context_length"), so it is
 * matched by suffix rather than by a list of families that would go stale.
 */
async function modelContextLength(
  model: string,
  target: OllamaTarget
): Promise<number | null> {
  try {
    const response = await fetchWithTimeout(`${ollamaHost(target)}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(target) },
      body: JSON.stringify({ model }),
      timeoutMs: 10_000,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      model_info?: Record<string, unknown>;
    };
    const info = body.model_info ?? {};
    for (const [key, value] of Object.entries(info)) {
      if (!key.endsWith("context_length")) continue;
      if (typeof value === "number" && value > 0) return value;
    }
    return null;
  } catch {
    return null;
  }
}

/** True when a daemon answered — used to explain an empty roster. */
export async function ollamaReachable(
  target: OllamaTarget = "ollama-cloud"
): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(`${ollamaHost(target)}/api/tags`, {
      method: "GET",
      headers: authHeaders(target),
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
  const messages: Array<{
    role: string;
    content: string;
    images?: string[];
  }> = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({
    role: "user",
    content: opts.prompt,
    ...(opts.images?.length ? { images: opts.images } : {}),
  });

  const target = opts.target ?? "ollama-cloud";
  const response = await fetchWithTimeout(`${ollamaHost(target)}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(target) },
    body: JSON.stringify({
      model: opts.model,
      messages,
      stream: false,
      ...(opts.json ? { format: "json" } : {}),
      options: {
        num_ctx: opts.numCtx ?? (await resolveNumCtx(opts.model, target)),
      },
    }),
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Ollama rejected the credentials for "${opts.model}" (${response.status}). ` +
          (ollamaApiKey(target)
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
