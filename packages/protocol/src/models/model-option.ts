import { z } from "zod";

export const ReasoningEffort = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

/** One selectable model, as reported live by the Claude Agent SDK. */
export const ModelOption = z.object({
  /** Id/alias passed to the SDK (e.g. "sonnet", "claude-opus-4-8"). */
  value: z.string(),
  /** Human label for the picker. */
  label: z.string(),
  description: z.string().optional(),
  /** Canonical wire id the value resolves to, when the SDK reports it. */
  resolvedModel: z.string().optional(),
  supportsEffort: z.boolean().optional(),
  /** Exact reasoning effort values this row supports, when the provider reports them. */
  reasoningLevels: z.array(ReasoningEffort).optional(),
  /** Which backend serves this row. */
  provider: z
    .enum(["claude", "ollama", "ollama-local", "codex"])
    .default("claude"),
});
export type ModelOption = z.infer<typeof ModelOption>;
