import { z } from "zod";
import { HookConfig } from "../models/hooks.js";

export const hooksMethods = {
  "hooks.list": {
    params: z.object({}).optional(),
    result: z.object({ hooks: z.array(HookConfig) }),
  },
  "hooks.save": {
    params: z.object({ hook: HookConfig }),
    result: z.object({ hook: HookConfig }),
  },
  "hooks.delete": {
    params: z.object({ id: z.string() }),
    result: z.object({}),
  },
} as const;
