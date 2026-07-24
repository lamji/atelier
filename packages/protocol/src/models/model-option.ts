import { z } from "zod";

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
});
export type ModelOption = z.infer<typeof ModelOption>;
