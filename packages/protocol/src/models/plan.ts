import { z } from "zod";

export const PlanStepStatus = z.enum([
  "pending",
  "in-progress",
  "done",
  "failed",
  "cancelled",
  "skipped",
]);
export type PlanStepStatus = z.infer<typeof PlanStepStatus>;

export const PlanStep = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string().optional(),
  files: z.array(z.string()).default([]),
  verification: z.string().optional(),
  status: PlanStepStatus.default("pending"),
  note: z.string().optional(),
});
export type PlanStep = z.infer<typeof PlanStep>;

export const Plan = z.object({
  id: z.string(),
  taskId: z.string(),
  goal: z.string(),
  rationale: z.string().optional(),
  steps: z.array(PlanStep),
  createdAt: z.number(),
});
export type Plan = z.infer<typeof Plan>;
