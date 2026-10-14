import { z } from "zod";
import { CliDoc, CliHistoryEntry, CliSessionChange } from "../models/cli.js";

export const cliMethods = {
  /**
   * Past sessions of the CLI providers, for this workspace only.
   *
   * Read-only and best-effort: an unknown provider, a missing home
   * directory, or a transcript format that has moved on yields fewer rows,
   * never an error — the CLI itself stays the source of truth.
   */
  "cli.history": {
    params: z
      .object({
        /** Omit for every known provider. */
        providerId: z.string().optional(),
        /** Transcript files inspected per provider in one page. Defaults to 30. */
        limit: z.number().optional(),
        /** Raw transcript page offset, advanced by `limit` after each page. */
        offset: z.number().int().min(0).optional(),
      })
      .optional(),
    result: z.object({ entries: z.array(CliHistoryEntry), hasMore: z.boolean() }),
  },
  /**
   * The app skills offered inside the provider CLIs, as paths into the
   * installed app. Nothing is copied into the user's home: Claude Code loads
   * `root` through `--add-dir`, and a CLI with no such option is pointed at
   * a skill's `file` when its command is typed.
   */
  "cli.skills": {
    params: z.object({}).optional(),
    result: z.object({
      /** Holds `.claude/skills/<name>`; null when the app ships none. */
      root: z.string().nullable(),
      skills: z.array(z.object({ name: z.string(), file: z.string() })),
      /**
       * What to add to each CLI's launch command, quoted for the pty's
       * shell: the skills folder and the SessionStart hook that loads them.
       */
      launch: z
        .object({ claude: z.string(), codex: z.string() })
        .default({ claude: "", codex: "" }),
    }),
  },
  /** The reports the `document` skill saved in this workspace, newest first. */
  "cli.docs.list": {
    params: z.object({}).optional(),
    result: z.object({ docs: z.array(CliDoc) }),
  },
  "cli.title.autoRename": {
    params: z.object({ providerId: z.string(), sessionId: z.string() }),
    result: z.object({ title: z.string() }),
  },
  "cli.diff.get": {
    params: z.object({ providerId: z.string(), sessionId: z.string() }),
    result: z.object({ changes: z.array(CliSessionChange) }),
  },
  "cli.diff.save": {
    params: z.object({
      providerId: z.string(),
      sessionId: z.string(),
      changes: z.array(CliSessionChange),
    }),
    result: z.object({ ok: z.boolean() }),
  },
} as const;
