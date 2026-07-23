import { z } from "zod";

export const TerminalSession = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  cols: z.number(),
  rows: z.number(),
  createdAt: z.number(),
  alive: z.boolean(),
});
export type TerminalSession = z.infer<typeof TerminalSession>;
