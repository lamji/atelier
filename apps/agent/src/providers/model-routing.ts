/**
 * The one seam that decides which backend a model id belongs to. Ollama
 * rows are namespaced with an "ollama/" prefix when they enter the picker,
 * so a model id is self-describing everywhere it travels — settings, task
 * options, the composer — and nothing else needs a provider flag.
 */

export const OLLAMA_PREFIX = "ollama/";
/**
 * The daemon on this machine, namespaced apart from the hosted service so
 * the two rosters can both be in the picker at once. The cloud prefix is
 * left exactly as it was: model ids are persisted in per-chat preferences,
 * and renaming them would repoint every chat that already picked one.
 */
export const OLLAMA_LOCAL_PREFIX = "ollama-local/";
export const CODEX_PREFIX = "codex/";

/** Which Ollama endpoint a model id belongs to; matches the provider ids. */
export type OllamaTarget = "ollama-cloud" | "ollama-local";

export function ollamaTargetOf(
  value: string | undefined | null
): OllamaTarget | null {
  if (typeof value !== "string") return null;
  if (value.startsWith(OLLAMA_LOCAL_PREFIX)) return "ollama-local";
  if (value.startsWith(OLLAMA_PREFIX)) return "ollama-cloud";
  return null;
}

export function isOllamaModel(value: string | undefined | null): boolean {
  return ollamaTargetOf(value) !== null;
}

export function isCodexModel(value: string | undefined | null): boolean {
  return typeof value === "string" && value.startsWith(CODEX_PREFIX);
}

/** "ollama/qwen2.5-coder:7b" -> "qwen2.5-coder:7b" (the tag Ollama knows). */
export function ollamaModelName(value: string): string {
  return value.startsWith(OLLAMA_LOCAL_PREFIX)
    ? value.slice(OLLAMA_LOCAL_PREFIX.length)
    : value.slice(OLLAMA_PREFIX.length);
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
