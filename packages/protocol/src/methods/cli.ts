import { z } from "zod";
import { CliHistoryEntry, CliSessionChange } from "../models/cli.js";

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
