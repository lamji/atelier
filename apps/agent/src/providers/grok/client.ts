import type { ImageAttachment } from "@atelier/protocol";
import { grokConfig } from "../credentials.js";
import { recordGrokUsage } from "./usage.js";

const DEFAULT_HOST = "https://api.x.ai/v1";
const DEFAULT_TIMEOUT_MS = 120_000;

export interface GrokModel {
  id: string;
  inputModalities: string[];
  contextLength?: number;
}

export function grokHost(): string {
  return (grokConfig().host || process.env.XAI_API_HOST || DEFAULT_HOST).replace(
    /\/$/,
    ""
  );
}

export function grokApiKey(): string | undefined {
  return grokConfig().apiKey || process.env.XAI_API_KEY;
}

export async function listGrokModels(): Promise<GrokModel[]> {
  const response = await grokFetch("/language-models", {}, DEFAULT_TIMEOUT_MS);
  if (!response.ok) throw await grokHttpError(response, "list models");
  const body = (await response.json()) as {
    models?: Array<{
      id?: string;
      input_modalities?: string[];
      output_modalities?: string[];
      context_length?: number;
    }>;
  };
  return (body.models ?? [])
    .filter(
      (model) =>
        typeof model.id === "string" &&
        (model.output_modalities ?? ["text"]).includes("text")
    )
    .map((model) => ({
      id: model.id!,
      inputModalities: model.input_modalities ?? ["text"],
      ...(model.context_length ? { contextLength: model.context_length } : {}),
    }));
}

export interface GrokChatOptions {
  model: string;
  system: string;
  prompt: string;
  signal?: AbortSignal;
  effort?: string;
  json?: boolean;
  images?: ImageAttachment[];
}

/** Tool-less Grok completion used by Atelier's internal pipeline stages. */
export async function grokChat(opts: GrokChatOptions): Promise<string> {
  const started = Date.now();
  const response = await grokFetch(
    "/chat/completions",
    {
      method: "POST",
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: userContent(opts.prompt, opts.images) },
        ],
        stream: false,
        ...(opts.effort ? { reasoning_effort: normalizeEffort(opts.effort) } : {}),
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: opts.signal,
    },
    DEFAULT_TIMEOUT_MS
  );
  if (!response.ok) throw await grokHttpError(response, `run model "${opts.model}"`);
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  recordGrokUsage({
    inputTokens: body.usage?.prompt_tokens,
    outputTokens: body.usage?.completion_tokens,
    durationMs: Date.now() - started,
  });
  return body.choices?.[0]?.message?.content ?? "";
}

export function userContent(
  prompt: string,
  images?: ImageAttachment[]
): string | Array<Record<string, unknown>> {
  if (!images?.length) return prompt;
  return [
    { type: "text", text: prompt },
    ...images.map((image) => ({
      type: "image_url",
      image_url: { url: `data:${image.mediaType};base64,${image.data}` },
    })),
  ];
}

export function normalizeEffort(effort: string): "low" | "medium" | "high" {
  if (effort === "low" || effort === "medium") return effort;
  return "high";
}

export async function grokFetch(
  pathname: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const key = grokApiKey();
  if (!key) throw new Error("Grok API key is not configured");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const onAbort = () => abort.abort();
  init.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetch(`${grokHost()}${pathname}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        ...init.headers,
      },
      signal: abort.signal,
    });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onAbort);
  }
}

export async function grokHttpError(
  response: Response,
  action: string
): Promise<Error> {
  const detail = await response.text().catch(() => "");
  if (response.status === 401 || response.status === 403) {
    return new Error(
      `Grok rejected the API key (${response.status}). Check the key in the xAI Console.`
    );
  }
  return new Error(
    `Grok ${response.status} while trying to ${action}: ${detail.slice(0, 300)}`
  );
}
