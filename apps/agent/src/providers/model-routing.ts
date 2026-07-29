/**
 * The one seam that decides which backend a model id belongs to. Ollama
 * rows are namespaced with an "ollama/" prefix when they enter the picker,
 * so a model id is self-describing everywhere it travels — settings, task
 * options, the composer — and nothing else needs a provider flag.
 */

export const OLLAMA_PREFIX = "ollama/";
export const CODEX_PREFIX = "codex/";

export function isOllamaModel(value: string | undefined | null): boolean {
  return typeof value === "string" && value.startsWith(OLLAMA_PREFIX);
}

export function isCodexModel(value: string | undefined | null): boolean {
  return typeof value === "string" && value.startsWith(CODEX_PREFIX);
}

/** "ollama/qwen2.5-coder:7b" -> "qwen2.5-coder:7b" (the tag Ollama knows). */
export function ollamaModelName(value: string): string {
  return value.slice(OLLAMA_PREFIX.length);
}

/** "codex/default" means let Codex CLI use the signed-in user's configured model. */
export function codexModelName(value: string): string | undefined {
  const name = value.slice(CODEX_PREFIX.length);
  return name === "default" ? undefined : name;
}

/**
 * The model id to hand the Claude Agent SDK. An Ollama id is meaningless
 * to the SDK, so it resolves to undefined. Callers that support Ollama must
 * branch before invoking Claude; this helper is only for the Claude path.
 */
export function sdkModel(value: string | undefined): string | undefined {
  if (!value || isOllamaModel(value) || isCodexModel(value)) return undefined;
  return value;
}
