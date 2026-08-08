import type { ModelOption } from "@atelier/protocol";
import { execa } from "execa";
import { CODEX_PREFIX } from "../model-routing.js";

interface CodexCatalog {
  models?: CodexCatalogModel[];
}

interface CodexCatalogModel {
  slug?: string;
  display_name?: string;
  description?: string;
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{ effort?: string }>;
  visibility?: string;
  priority?: number;
  additional_speed_tiers?: string[];
}

export interface CodexAuthStatus {
  ok: boolean;
  detail: string;
}

/** Honest account check for Settings; model fallbacks are not auth proof. */
export async function probeCodexAuth(): Promise<CodexAuthStatus> {
  try {
    const result = await execa("codex", ["login", "status"], {
      // Runs at session start; without this it flashes a console window.
      windowsHide: true,
      reject: false,
      timeout: 30_000,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    const ok = result.exitCode === 0 && /logged in/i.test(output);
    return {
      ok,
      detail: ok
        ? output || "Signed in to Codex."
        : output || "Codex CLI is not signed in. Run `codex login`.",
    };
  } catch {
    return {
      ok: false,
      detail: "Codex CLI is unavailable. Install it and run `codex login`.",
    };
  }
}

/** Codex CLI route. Runs through the user's signed-in ChatGPT/Codex session. */
export async function probeCodexModels(): Promise<ModelOption[]> {
  try {
    if (!(await probeCodexAuth()).ok) return [];
    const result = await execa("codex", ["debug", "models"], {
      windowsHide: true,
      reject: false,
      timeout: 30_000,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    if (result.exitCode !== 0) return fallbackCodexModels();
    const catalog = JSON.parse(result.stdout) as CodexCatalog;
    const models = (catalog.models ?? [])
      .filter((model) => model.slug && model.visibility !== "hide")
      .sort((a, b) => priority(a) - priority(b))
      .map(toModelOption);
    return models.length > 0 ? models : fallbackCodexModels();
  } catch {
    return fallbackCodexModels();
  }
}

function toModelOption(model: CodexCatalogModel): ModelOption {
  const reasoningLevels = (model.supported_reasoning_levels ?? [])
    .map((level) => level.effort)
    .filter(isReasoningLevel);
  const defaultHint = model.default_reasoning_level
    ? `default ${model.default_reasoning_level}`
    : "";
  const tierHint = model.additional_speed_tiers?.includes("fast")
    ? "Fast tier available"
    : "";
  return {
    value: `${CODEX_PREFIX}${model.slug}`,
    label: model.display_name ?? model.slug!,
    description: [model.description, defaultHint, tierHint]
      .filter(Boolean)
      .join(" - "),
    resolvedModel: model.slug,
    provider: "codex" as const,
    supportsEffort: reasoningLevels.length > 0,
    ...(reasoningLevels.length > 0 ? { reasoningLevels } : {}),
  };
}

function priority(model: CodexCatalogModel): number {
  return model.priority ?? Number.MAX_SAFE_INTEGER;
}

function isReasoningLevel(
  value: string | undefined
): value is NonNullable<ModelOption["reasoningLevels"]>[number] {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max" ||
    value === "ultra"
  );
}

function fallbackCodexModels(): ModelOption[] {
  return [
    {
      value: `${CODEX_PREFIX}default`,
      label: "Codex",
      description: "Codex CLI - signed-in ChatGPT/Codex session",
      provider: "codex" as const,
      supportsEffort: false,
    },
  ];
}
