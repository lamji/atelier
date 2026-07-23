import { z } from "zod";
import { TerminalSession } from "../models/terminal.js";

export const terminalMethods = {
  "terminal.create": {
    params: z.object({
      cwd: z.string().optional(),
      name: z.string().optional(),
      cols: z.number().optional(),
      rows: z.number().optional(),
    }),
    result: z.object({ session: TerminalSession }),
  },
  "terminal.write": {
    params: z.object({ termId: z.string(), data: z.string() }),
    result: z.object({}),
  },
  "terminal.resize": {
    params: z.object({ termId: z.string(), cols: z.number(), rows: z.number() }),
    result: z.object({}),
  },
  "terminal.kill": {
    params: z.object({ termId: z.string() }),
    result: z.object({}),
  },
  "terminal.list": {
    params: z.object({}).optional(),
    result: z.object({ sessions: z.array(TerminalSession) }),
  },
  "terminal.getHistory": {
    params: z.object({ termId: z.string() }),
    result: z.object({ data: z.string() }),
  },
} as const;
