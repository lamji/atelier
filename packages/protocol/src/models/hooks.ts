import { z } from "zod";

export const HookEvent = z.enum([
  "preTask",
  "preStage",
  "preTool",
  "postTool",
  "postTask",
]);
export type HookEvent = z.infer<typeof HookEvent>;

export const HookAction = z.enum(["allow", "block", "runCommand", "annotate"]);
export type HookAction = z.infer<typeof HookAction>;

export const HookConfig = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().default(true),
  event: HookEvent,
  /** Tool name or stage name to match ("*" = all). */
  matcher: z.string().default("*"),
  /** Glob applied to file paths in tool input, when present. */
  pathGlob: z.string().optional(),
  action: HookAction,
  /** Shell command for runCommand, message for block/annotate. */
  argument: z.string().optional(),
});
export type HookConfig = z.infer<typeof HookConfig>;
