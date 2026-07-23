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

export const ChatRole = z.enum(["user", "assistant"]);
export type ChatRole = z.infer<typeof ChatRole>;

export const ChatMessage = z.object({
  id: z.string(),
  conversationId: z.string(),
  taskId: z.string().optional(),
  role: ChatRole,
  text: z.string(),
  createdAt: z.number(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;
