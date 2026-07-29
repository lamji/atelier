import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelOption } from "@atelier/protocol";

interface RawModelInfo {
  value: string;
  displayName?: string;
  description?: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
}

type MaybeModelsQuery = {
  supportedModels?: () => Promise<RawModelInfo[]>;
};

/**
 * Reads the live model roster from the Claude Agent SDK — the same list
 * `/model` shows, so it tracks whatever Anthropic currently offers
 * (Fable, Opus, Sonnet, Haiku, …) instead of a hardcoded set. Runs a
 * control request on an idle session, so it costs a process, not tokens.
 *
 * Returns [] when the SDK can't be probed (offline, missing method); the
 * UI then falls back to its built-in list.
 */
export async function probeModels(cwd: string): Promise<ModelOption[]> {
  const abort = new AbortController();
  const idlePrompt = (async function* () {
    await new Promise<void>((resolve) => {
      abort.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  })();

  try {
    const session = query({
      prompt: idlePrompt as never,
      options: { cwd, abortController: abort, settingSources: [] },
    });
    const control = session as unknown as MaybeModelsQuery;
    if (typeof control.supportedModels !== "function") return [];

    const models = await control.supportedModels();
    return models
      .filter((m) => m && typeof m.value === "string")
      .map((m) => ({
        value: m.value,
        label: m.displayName ?? m.value,
        description: m.description,
        resolvedModel: m.resolvedModel,
        supportsEffort: m.supportsEffort,
        provider: "claude" as const,
      }));
  } catch {
    return [];
  } finally {
    abort.abort();
  }
}
