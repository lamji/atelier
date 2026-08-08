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

/**
 * A rule the user wrote, as the settings panel sees it. The body stays on
 * disk — the panel lists titles and opens the file in the editor, so it
 * never needs to carry the text.
 */
export const UserRule = z.object({
  /** Workspace-relative path, e.g. ".atelier/rules/no-any.md". */
  path: z.string(),
  title: z.string(),
  /** Enabled rules are appended to the system rules on every run. */
  enabled: z.boolean(),
});
export type UserRule = z.infer<typeof UserRule>;

export const settingsMethods = {
  "settings.get": {
    params: z.object({}).optional(),
    result: z.object({ settings: Settings }),
  },
  "settings.save": {
    params: z.object({ settings: Settings.partial() }),
    result: z.object({ settings: Settings }),
  },
  /** The user's own rules: one markdown file each, under .atelier/rules. */
  "rules.list": {
    params: z.object({}).optional(),
    result: z.object({ rules: z.array(UserRule) }),
  },
  "rules.create": {
    params: z.object({ name: z.string() }),
    result: z.object({ rule: UserRule }),
  },
  /** Off keeps the file; it just stops riding along with the next run. */
  "rules.setEnabled": {
    params: z.object({ path: z.string(), enabled: z.boolean() }),
    result: z.object({ rule: UserRule }),
  },
  "rules.delete": {
    params: z.object({ path: z.string() }),
    result: z.object({ ok: z.boolean() }),
  },
} as const;
