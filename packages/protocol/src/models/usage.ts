import { z } from "zod";

/** One plan rate-limit window (5-hour, weekly, per-model …). */
export const UsageWindow = z.object({
  /** Window id from the SDK: five_hour, seven_day, seven_day_opus, … */
  kind: z.string(),
  /** Human label for the status bar ("5h", "week", "week · Opus"). */
  label: z.string(),
  /** Percent of the window consumed, 0-100. */
  utilization: z.number(),
  /** Epoch ms when the window resets, when known. */
  resetsAt: z.number().nullable().default(null),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

/**
 * Plan usage as last seen. `available` is false for API-key / Bedrock /
 * Vertex sessions, where plan limits do not apply.
 */
export const UsageSnapshot = z.object({
  available: z.boolean(),
  status: z
    .enum(["allowed", "allowed_warning", "rejected"])
    .nullable()
    .default(null),
  windows: z.array(UsageWindow).default([]),
  /** Epoch ms of the last update, so the UI can show staleness. */
  updatedAt: z.number().nullable().default(null),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshot>;
