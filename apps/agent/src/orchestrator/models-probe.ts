import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelOption } from "@atelier/protocol";

interface RawModelInfo {
  value: string;
  displayName?: string;
  description?: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
}

interface RawAccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  apiProvider?: string;
}

type MaybeModelsQuery = {
  supportedModels?: () => Promise<RawModelInfo[]>;
  accountInfo?: () => Promise<RawAccountInfo>;
};

export interface ClaudeAuthStatus {
  ok: boolean;
  detail: string;
}

/**
 * Reads the authenticated account through the Claude Agent SDK itself. This
 * is the same auth boundary execution uses, not a guessed config-file check.
 */
export async function probeClaudeAuth(cwd: string): Promise<ClaudeAuthStatus> {
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
    if (typeof control.accountInfo !== "function") {
      return {
        ok: false,
        detail: "Claude Agent SDK cannot report an authenticated account.",
      };
    }
    const account = await control.accountInfo();
    const identity = account.email ?? account.organization;
    const plan = account.subscriptionType;
    return {
      ok: true,
      detail: [
        "Signed in through Claude Agent SDK",
        identity ? `as ${identity}` : "",
        plan ? `(${plan})` : "",
      ]
        .filter(Boolean)
        .join(" "),
    };
  } catch {
    return {
      ok: false,
      detail: "Claude Agent SDK is not signed in. Run `claude auth login`.",
    };
  } finally {
    abort.abort();
  }
}

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
    if (
      typeof control.supportedModels !== "function" ||
      typeof control.accountInfo !== "function"
    ) {
      return [];
    }

    // A catalog is useful only when the same SDK session can authenticate.
    await control.accountInfo();
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
