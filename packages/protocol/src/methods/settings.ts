import { z } from "zod";

export const Settings = z.object({
  workspaceRoot: z.string(),
  model: z.string().optional(),
  ignoreGlobs: z.array(z.string()).default([]),
  disabledSkills: z.array(z.string()).default([]),
  /**
   * Branches the agent may not edit on, as exact names or globs
   * ("main", "release/*").
   *
   * A workspace setting rather than a per-repo one: the same rule —
   * never let an agent write while the checkout is on main — is the one
   * the user means for every checkout in the folder, and per-repo lists
   * would have to be re-stated for each of them.
   */
  protectedBranches: z.array(z.string()).default([]),
  /** Experimental: let promoted sessions participate in cross-session RAG. */
  globalSessionKnowledge: z.boolean().default(false),
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

/** What kind of fact a workspace memory holds. */
export const MemoryType = z.enum([
  "correction",
  "environment",
  "naming",
  "preference",
  "fact",
]);
export type MemoryType = z.infer<typeof MemoryType>;

/**
 * One entry of the workspace's own memory: a file under .atelier/memory,
 * read into every CLI session Atelier starts.
 */
export const MemoryEntry = z.object({
  /** The file stem, kebab-case: `.atelier/memory/<name>.md`. */
  name: z.string(),
  /** One line: what the entry is about, shown in the list. */
  description: z.string(),
  type: MemoryType,
  body: z.string(),
  updatedAt: z.number(),
});
export type MemoryEntry = z.infer<typeof MemoryEntry>;

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
  /** The workspace's own memory, newest first. */
  "memory.list": {
    params: z.object({}).optional(),
    result: z.object({ entries: z.array(MemoryEntry) }),
  },
  /** Create or edit; a changed name renames the file. */
  "memory.save": {
    params: z.object({
      name: z.string(),
      description: z.string(),
      type: MemoryType,
      body: z.string(),
      previousName: z.string().optional(),
    }),
    result: z.object({ entry: MemoryEntry }),
  },
  "memory.delete": {
    params: z.object({ name: z.string() }),
    result: z.object({ ok: z.boolean() }),
  },
} as const;
