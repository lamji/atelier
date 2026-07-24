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

/**
 * A database operation the agent is holding on, waiting for the user to
 * approve it in the UI. The tool call stays parked until the answer (or
 * the deadline) arrives.
 */
export const DbApprovalRequest = z.object({
  id: z.string(),
  /** Short label: "migration", "database client", "SQL statement", … */
  operation: z.string(),
  /** The command the agent wants to run, as typed. */
  command: z.string(),
  /** Why it was held — the rule that matched. */
  detail: z.string(),
  /** Epoch ms after which the request auto-denies. */
  expiresAt: z.number(),
});
export type DbApprovalRequest = z.infer<typeof DbApprovalRequest>;

export const DbApprovalOutcome = z.enum([
  "approved",
  "denied",
  "expired",
  "cancelled",
]);
export type DbApprovalOutcome = z.infer<typeof DbApprovalOutcome>;

export const DbApprovalResolved = z.object({
  id: z.string(),
  outcome: DbApprovalOutcome,
});
export type DbApprovalResolved = z.infer<typeof DbApprovalResolved>;
