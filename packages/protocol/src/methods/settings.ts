import { z } from "zod";

export const Settings = z.object({
  workspaceRoot: z.string(),
  model: z.string().optional(),
  ignoreGlobs: z.array(z.string()).default([]),
  disabledSkills: z.array(z.string()).default([]),
  maxValidationRetries: z.number().default(2),
  maxReviewRetries: z.number().default(2),
});
export type Settings = z.infer<typeof Settings>;

export const settingsMethods = {
  "settings.get": {
    params: z.object({}).optional(),
    result: z.object({ settings: Settings }),
  },
  "settings.save": {
    params: z.object({ settings: Settings.partial() }),
    result: z.object({ settings: Settings }),
  },
  /**
   * The standing rules every agent run is given, verbatim. Read-only, and
   * served from the same constant the orchestrator injects, so what the
   * panel shows can never drift from what the agent was actually told.
   */
  "settings.rules": {
    params: z.object({}).optional(),
    result: z.object({ rules: z.string() }),
  },
} as const;
