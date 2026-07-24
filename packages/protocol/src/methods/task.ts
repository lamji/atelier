import { z } from "zod";
import { TaskInfo } from "../models/conversation.js";
import { EventFrame } from "../envelope.js";

/** A base64-encoded image attached to a message (screenshot, paste, drop). */
export const ImageAttachment = z.object({
  /** e.g. "image/png", "image/jpeg". */
  mediaType: z.string(),
  /** Base64 payload with NO data: URL prefix. */
  data: z.string(),
});
export type ImageAttachment = z.infer<typeof ImageAttachment>;

export const taskMethods = {
  "task.start": {
    params: z.object({
      conversationId: z.string(),
      prompt: z.string(),
      model: z.string().optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      planMode: z.boolean().optional(),
      /** Pasted/dropped/picked images the model should see this turn. */
      images: z.array(ImageAttachment).optional(),
    }),
    result: z.object({ taskId: z.string() }),
  },
  "task.cancel": {
    params: z.object({ taskId: z.string() }),
    result: z.object({ cancelled: z.boolean() }),
  },
  "task.list": {
    params: z.object({ activeOnly: z.boolean().optional() }).optional(),
    result: z.object({ tasks: z.array(TaskInfo) }),
  },
  "task.getTimeline": {
    params: z.object({
      taskId: z.string(),
      cursor: z.number().optional(),
      limit: z.number().optional(),
    }),
    result: z.object({
      entries: z.array(EventFrame),
      nextCursor: z.number().nullable(),
    }),
  },
} as const;
