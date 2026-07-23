import { z } from "zod";

export const Settings = z.object({
  workspaceRoot: z.string(),
  model: z.string().optional(),
  ignoreGlobs: z.array(z.string()).default([]),
  maxValidationRetries: z.number().default(2),
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
} as const;
