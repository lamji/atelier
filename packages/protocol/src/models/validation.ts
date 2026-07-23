import { z } from "zod";

export const ValidationKind = z.enum(["lint", "test", "typecheck"]);
export type ValidationKind = z.infer<typeof ValidationKind>;

export const ValidationFinding = z.object({
  path: z.string().optional(),
  row: z.number().optional(),
  col: z.number().optional(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  rule: z.string().optional(),
});
export type ValidationFinding = z.infer<typeof ValidationFinding>;

export const ValidationResult = z.object({
  kind: ValidationKind,
  ok: z.boolean(),
  findings: z.array(ValidationFinding),
  rawOutput: z.string().optional(),
  durationMs: z.number(),
});
export type ValidationResult = z.infer<typeof ValidationResult>;
