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
  /** Observed proof (test/typecheck/validation); unset = model-asserted. */
  verification: z.string().optional(),
  status: PlanStepStatus.default("pending"),
  /** Model's outcome note; carries "[unverified — model-asserted]" when so. */
  note: z.string().optional(),
});
export type PlanStep = z.infer<typeof PlanStep>;

export const Plan = z.object({
  id: z.string(),
  taskId: z.string(),
  goal: z.string(),
  rationale: z.string().optional(),
  steps: z.array(PlanStep),
  /**
   * Requested items this plan deliberately does NOT deliver, as the model
   * declared them at set_plan. Shown to the user with the final report so
   * a narrowed scope is stated, never implied by silence.
   */
  notCovered: z.array(z.string()).optional(),
  createdAt: z.number(),
});
export type Plan = z.infer<typeof Plan>;
