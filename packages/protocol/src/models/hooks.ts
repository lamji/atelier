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
 * A command the agent is holding until the user answers in the UI. Database
 * and npm-family approvals share this payload so one queue and one resolver
 * can safely handle both kinds of human-in-the-loop work.
 */
export const ApprovalRequest = z.object({
  id: z.string(),
  kind: z.enum(["database", "npm"]).default("database"),
  /** Short label: "migration", "npm run build", "SQL statement", … */
  operation: z.string(),
  /** The command the agent wants to run, as typed. */
  command: z.string(),
  /** Why it was held — the rule that matched. */
  detail: z.string(),
  /** Epoch ms after which the request auto-denies. */
  expiresAt: z.number(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

export const ApprovalOutcome = z.enum([
  "approved",
  "denied",
  "expired",
  "cancelled",
]);
export type ApprovalOutcome = z.infer<typeof ApprovalOutcome>;

export const ApprovalResolved = z.object({
  id: z.string(),
  outcome: ApprovalOutcome,
});
export type ApprovalResolved = z.infer<typeof ApprovalResolved>;

/** Backward-compatible names for the existing database approval flow. */
export const DbApprovalRequest = ApprovalRequest;
export type DbApprovalRequest = ApprovalRequest;
export const DbApprovalOutcome = ApprovalOutcome;
export type DbApprovalOutcome = ApprovalOutcome;
export const DbApprovalResolved = ApprovalResolved;
export type DbApprovalResolved = ApprovalResolved;

/** Names used by the npm-family approval event topics. */
export const NpmApprovalRequest = ApprovalRequest;
export type NpmApprovalRequest = ApprovalRequest;
export const NpmApprovalResolved = ApprovalResolved;
export type NpmApprovalResolved = ApprovalResolved;
