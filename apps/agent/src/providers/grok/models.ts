import type { ModelOption, ProviderModel } from "@atelier/protocol";
import { enabledModelsFor, GROK, providerEnabled } from "../credentials.js";
import { GROK_PREFIX } from "../model-routing.js";
import { listGrokModels, type GrokModel } from "./client.js";

function enabledSet(): Set<string> {
  return new Set(enabledModelsFor(GROK));
}

export async function probeGrokModels(): Promise<ModelOption[]> {
  if (!providerEnabled(GROK) || enabledModelsFor(GROK).length === 0) return [];
  const enabled = enabledSet();
  return (await listGrokModels())
    .filter((model) => enabled.has(model.id))
    .map((model) => ({
      value: `${GROK_PREFIX}${model.id}`,
      label: model.id,
      description: describe(model),
      provider: "grok" as const,
      supportsEffort: true,
      reasoningLevels: ["low", "medium", "high"] as ModelOption["reasoningLevels"],
    }));
}

export async function listGrokCatalog(): Promise<ProviderModel[]> {
  const enabled = enabledSet();
  return (await listGrokModels())
    .map((model) => ({
      value: `${GROK_PREFIX}${model.id}`,
      name: model.id,
      enabled: enabled.has(model.id),
      detail: describe(model),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function describe(model: GrokModel): string {
  const vision = model.inputModalities.includes("image") ? "text + images" : "text";
  const context = model.contextLength
    ? ` · ${Math.round(model.contextLength / 1000)}k context`
    : "";
  return `${model.id} · xAI · ${vision}${context}`;
}
