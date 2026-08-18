import { z } from "zod";

export const Conversation = z.object({
  id: z.string(),
  title: z.string(),
  sdkSessionId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Conversation = z.infer<typeof Conversation>;

export const TaskStatus = z.enum([
  /** Typed while another task held the conversation; runs when that one ends. */
  "queued",
  "running",
  "completed",
  "cancelled",
  "error",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskInfo = z.object({
  id: z.string(),
  conversationId: z.string(),
  prompt: z.string(),
  status: TaskStatus,
  startedAt: z.number(),
  endedAt: z.number().nullable(),
});
export type TaskInfo = z.infer<typeof TaskInfo>;

export const ChatRole = z.enum(["user", "assistant", "log", "diff"]);
export type ChatRole = z.infer<typeof ChatRole>;

export const ChatMessageDiff = z.object({
  path: z.string(),
  before: z.string(),
  after: z.string(),
});
export type ChatMessageDiff = z.infer<typeof ChatMessageDiff>;

export const ChatMessage = z.object({
  id: z.string(),
  conversationId: z.string(),
  taskId: z.string().optional(),
  role: ChatRole,
  text: z.string(),
  createdAt: z.number(),
  /** Source event topic for a "log" message (e.g. "knowledge.retrieved"). */
  logTopic: z.string().optional(),
  /**
   * Long-form body behind a "log" line — the full context an LLM request
   * carried, for instance. Shown only when the row is expanded.
   */
  logDetail: z.string().optional(),
  /** File edit for a "diff" message, shown inline as a VS Code-style diff. */
  diff: ChatMessageDiff.optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;
