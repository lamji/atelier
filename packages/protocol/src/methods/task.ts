import { z } from "zod";
import { TaskInfo } from "../models/conversation.js";
import { ReasoningEffort } from "../models/model-option.js";
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
      effort: ReasoningEffort.optional(),
      planMode: z.boolean().optional(),
      /** Vibe coding: autonomous product-builder mode for this task. */
      vibe: z.boolean().optional(),
      /**
       * Independent review stage after the changes land. Omitted means NO —
       * only an explicit `true` runs review and its repair rounds. It costs
       * a fresh SDK session per attempt, entirely after the answer has
       * finished streaming, so an interactive send does not pay for it.
       */
      autoReview: z.boolean().optional(),
      /**
       * Run the validators (typecheck, lint, test) over what the task
       * changed. Omitted means NO — only an explicit `true` runs them.
       * They are package scripts on a whole monorepo, they run entirely
       * after the answer has finished streaming, and they block the turn
       * from ending, so an interactive send does not pay for them.
       */
      autoValidate: z.boolean().optional(),
      /**
       * Run this task through Atelier's knowledge engine — retrieval,
       * impact, plan, review, session memory. Omitted means yes; `false`
       * bypasses the pipeline for a plain Claude/Codex turn.
       */
      systemKnowledge: z.boolean().optional(),
      /**
       * Confine the task to these project directories (workspace-relative)
       * instead of inferring the lock from "@mentions" in the prompt.
       */
      scopeRoots: z.array(z.string()).optional(),
      /** Pasted/dropped/picked images the model should see this turn. */
      images: z.array(ImageAttachment).optional(),
      /** The `.atelier/*.md` note this prompt came from. Its status follows
       *  the task, and the run's report is appended to it when it ends. */
      promptFile: z.string().optional(),
    }),
    result: z.object({
      taskId: z.string(),
      /**
       * The conversation was busy, so this turn is queued behind the
       * running one rather than started. It is persisted and will emit
       * task.started by itself; the composer must not mark the session
       * busy on this id.
       */
      queued: z.boolean().default(false),
    }),
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
