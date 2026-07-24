import { z } from "zod";
import { UsageSnapshot } from "../models/usage.js";

export const usageMethods = {
  /** Current plan usage; `refresh` re-probes the SDK instead of serving
   *  the cached snapshot. */
  "usage.get": {
    params: z.object({ refresh: z.boolean().optional() }).optional(),
    result: z.object({ usage: UsageSnapshot }),
  },
} as const;
