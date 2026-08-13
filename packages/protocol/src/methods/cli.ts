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
        /** Most recent N per provider. Defaults to 20. */
        limit: z.number().optional(),
      })
      .optional(),
    result: z.object({ entries: z.array(CliHistoryEntry) }),
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
