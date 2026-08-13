import type { ModelOption, ProviderModel } from "@atelier/protocol";
import {
  isCloudHost,
  listOllamaModels,
  supportsThinking,
  type OllamaModel,
} from "./client.js";
import {
  OLLAMA_LOCAL_PREFIX,
  OLLAMA_PREFIX,
  type OllamaTarget,
} from "../model-routing.js";
import {
  allowlistImpliesAll,
  enabledModelsFor,
  OLLAMA_CLOUD,
  OLLAMA_LOCAL,
  providerEnabled,
  subscriptionRequiredModelsFor,
} from "../credentials.js";

/** Cloud and the daemon are independent providers with independent rosters. */
const TARGETS: OllamaTarget[] = ["ollama-cloud", "ollama-local"];

/** Model-id namespace per endpoint, so a tag routes back to its host. */
const PREFIX: Record<OllamaTarget, string> = {
  "ollama-cloud": OLLAMA_PREFIX,
  "ollama-local": OLLAMA_LOCAL_PREFIX,
};

/**
 * The Ollama models the user switched on, shaped for the same picker the
 * SDK roster feeds. Empty when nothing is enabled or nothing answers, so
 * the composer simply shows the Claude rows.
 *
 * Both configured endpoints are probed. The local call is loopback-only and
 * returns immediately when the daemon is running or refuses the connection.
 */
export async function probeOllamaModels(): Promise<ModelOption[]> {
  const rosters = await Promise.all(TARGETS.map((target) => probe(target)));
  return rosters.flat();
}

async function probe(target: OllamaTarget): Promise<ModelOption[]> {
  // Switched off in Settings: nothing of this endpoint's belongs in the
  // picker, and there is no point paying for the round trip to find out.
  if (!providerEnabled(target)) return [];
  // The hosted endpoint costs a network round trip, so an account with
  // nothing switched on is not worth asking. The local daemon is on this
  // machine and either answers at once or refuses the connection.
  if (target === OLLAMA_CLOUD && enabledModelsFor(target).length === 0) return [];

  const models = await listOllamaModels(target);
  const enabled = enabledSet(target, models);
  const restricted = new Set(subscriptionRequiredModelsFor(target));
  const offered = models.filter(
    (m) => enabled.has(m.name) && !restricted.has(m.name)
  );
  // Honest reasoning per row: a thinking-capable model exposes exactly the
  // two states the agent loop can actually deliver (the hidden pass off or
  // on), so the picker never offers levels that do nothing. Probes are
  // cached per model, and only enabled rows — a handful — are asked.
  return Promise.all(
    offered.map(async (m) => {
      const thinking = await supportsThinking(m.name, target).catch(() => false);
      return {
        value: `${PREFIX[target]}${m.name}`,
        label: m.name,
        description: describe(target, m.name, m.parameterSize, m.quantization),
        provider:
          target === OLLAMA_LOCAL ? ("ollama-local" as const) : ("ollama" as const),
        supportsEffort: thinking,
        ...(thinking
          ? { reasoningLevels: ["low", "high"] as ModelOption["reasoningLevels"] }
          : {}),
      };
    })
  );
}

/**
 * Which tags reach the picker.
 *
 * An untouched LOCAL allowlist means every model the daemon has pulled:
 * running `ollama pull` is already an explicit choice, and having to
 * re-declare it in Settings is exactly what made the pull look like it did
 * nothing. The hosted account stays opt-in — it offers far more models than
 * anyone wants in a picker.
 */
function enabledSet(target: OllamaTarget, models: OllamaModel[]): Set<string> {
  const stored = enabledModelsFor(target);
  if (stored.length > 0) return new Set(stored);
  if (allowlistImpliesAll(target)) return new Set(models.map((m) => m.name));
  return new Set();
}

/**
 * The provider's full catalog for the Settings list, each row carrying
 * whether it is switched on. Unlike the picker roster this is never
 * filtered — the toggles are what the user is here to change.
 */
export async function listOllamaCatalog(
  target: OllamaTarget = "ollama-cloud"
): Promise<ProviderModel[]> {
  const models = await listOllamaModels(target);
  const enabled = enabledSet(target, models);
  const restricted = new Set(subscriptionRequiredModelsFor(target));
  return models
    .map((m) => ({
      value: `${PREFIX[target]}${m.name}`,
      name: m.name,
      enabled: enabled.has(m.name) && !restricted.has(m.name),
      subscriptionRequired: restricted.has(m.name),
      ...(sizeOf(m.parameterSize, m.quantization)
        ? { detail: sizeOf(m.parameterSize, m.quantization) }
        : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function sizeOf(parameterSize?: string, quantization?: string): string {
  return [parameterSize, quantization].filter(Boolean).join(" ");
}

/**
 * Leading segment is the model tag: the picker derives its label from the
 * text before the first "·", so this is what the row reads as.
 */
function describe(
  target: OllamaTarget,
  name: string,
  parameterSize?: string,
  quantization?: string
): string {
  // A "-cloud" tag is served upstream even through a local daemon, so the
  // tag decides the wording when the host itself isn't the cloud one.
  const where =
    isCloudHost(target) || name.includes("-cloud")
      ? "Ollama Cloud"
      : "local via Ollama";
  return [name, where, sizeOf(parameterSize, quantization)]
    .filter(Boolean)
    .join(" · ");
}
