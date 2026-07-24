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
  /** Answers a parked database operation. ok=false: already resolved. */
  "hooks.resolveApproval": {
    params: z.object({ id: z.string(), approved: z.boolean() }),
    result: z.object({ ok: z.boolean() }),
  },
} as const;
