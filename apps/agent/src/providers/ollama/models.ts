import type { ModelOption, ProviderModel } from "@atelier/protocol";
import { isCloudHost, listOllamaModels } from "./client.js";
import { OLLAMA_PREFIX } from "../model-routing.js";
import { enabledModelsFor, OLLAMA_CLOUD } from "../credentials.js";

/**
 * The Ollama models the user switched on, shaped for the same picker the
 * SDK roster feeds. Empty when nothing is enabled or nothing answers, so
 * the composer simply shows the Claude rows.
 */
export async function probeOllamaModels(): Promise<ModelOption[]> {
  const enabled = new Set(enabledModelsFor(OLLAMA_CLOUD));
  if (enabled.size === 0) return [];

  const models = await listOllamaModels();
  return models
    .filter((m) => enabled.has(m.name))
    .map((m) => ({
      value: `${OLLAMA_PREFIX}${m.name}`,
      label: m.name,
      description: describe(m.name, m.parameterSize, m.quantization),
      provider: "ollama" as const,
      supportsEffort: false,
    }));
}

/**
 * The provider's full catalog for the Settings list, each row carrying
 * whether it is switched on. Unlike the picker roster this is never
 * filtered — the toggles are what the user is here to change.
 */
export async function listOllamaCatalog(): Promise<ProviderModel[]> {
  const enabled = new Set(enabledModelsFor(OLLAMA_CLOUD));
  const models = await listOllamaModels();
  return models
    .map((m) => ({
      value: `${OLLAMA_PREFIX}${m.name}`,
      name: m.name,
      enabled: enabled.has(m.name),
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
  name: string,
  parameterSize?: string,
  quantization?: string
): string {
  // A "-cloud" tag is served upstream even through a local daemon, so the
  // tag decides the wording when the host itself isn't the cloud one.
  const where =
    isCloudHost() || name.includes("-cloud") ? "Ollama Cloud" : "local via Ollama";
  return [name, where, sizeOf(parameterSize, quantization)]
    .filter(Boolean)
    .join(" · ");
}
