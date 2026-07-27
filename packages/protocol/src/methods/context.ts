import { z } from "zod";
import { ContextRequestStats, ContextTotals } from "../models/context.js";

export const contextMethods = {
  /** Context-engineering accounting: recent requests + rollup totals. */
  "context.stats": {
    params: z
      .object({
        conversationId: z.string().optional(),
        limit: z.number().optional(),
      })
      .optional(),
    result: z.object({
      requests: z.array(ContextRequestStats),
      totals: ContextTotals,
    }),
  },
} as const;
