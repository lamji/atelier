import { z } from "zod";

export const DiffHunk = z.object({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(z.string()),
});
export type DiffHunk = z.infer<typeof DiffHunk>;

export const Diff = z.object({
  id: z.string(),
  taskId: z.string().optional(),
  path: z.string(),
  before: z.string(),
  after: z.string(),
  hunks: z.array(DiffHunk).default([]),
  createdAt: z.number(),
  applied: z.boolean().default(false),
});
export type Diff = z.infer<typeof Diff>;
