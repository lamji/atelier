import { z } from "zod";
import { TerminalSession } from "../models/terminal.js";

export const terminalMethods = {
  "terminal.freePort": {
    params: z.object({
      start: z.number().int().min(1).max(65_535),
      span: z.number().int().min(1).max(1_000).optional(),
      exclude: z.array(z.number().int().min(1).max(65_535)).optional(),
    }),
    result: z.object({ port: z.number().int().min(1).max(65_535) }),
  },
  /**
   * Which of these commands actually resolve on the machine's PATH, so a
   * caller can avoid offering a command whose binary is not installed.
   */
  "terminal.hasCommand": {
    params: z.object({ commands: z.array(z.string().min(1)).min(1).max(32) }),
    result: z.object({ available: z.record(z.string(), z.boolean()) }),
  },
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
  /**
   * Force-stops whatever the shell is running without closing the shell —
   * the second Ctrl+C. `killed` is how many processes actually went down.
   */
  "terminal.interrupt": {
    params: z.object({ termId: z.string() }),
    result: z.object({ killed: z.number() }),
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
