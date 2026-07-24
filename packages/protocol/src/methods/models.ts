import { z } from "zod";
import { ModelOption } from "../models/model-option.js";

export const modelsMethods = {
  /** Live model roster from the SDK; empty when it can't be probed. */
  "models.list": {
    params: z.object({}).optional(),
    result: z.object({ models: z.array(ModelOption) }),
  },
} as const;
