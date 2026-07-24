import { z } from "zod";
import { AgentStatus } from "../events.js";
import { Conversation, ChatMessage } from "../models/conversation.js";

/** A slash command or user-invocable skill the composer can offer. */
export const SlashCommand = z.object({
  /** Invocation name without the leading slash, e.g. "annotate". */
  name: z.string(),
  description: z.string(),
  kind: z.enum(["command", "skill"]),
  scope: z.enum(["user", "project"]),
});
export type SlashCommand = z.infer<typeof SlashCommand>;

export const sessionMethods = {
  "session.hello": {
    params: z.object({
      token: z.string(),
      protocolVersion: z.number(),
      clientInfo: z.object({
        name: z.string(),
        version: z.string(),
      }),
    }),
    result: z.object({
      sessionId: z.string(),
      agentVersion: z.string(),
      protocolVersion: z.number(),
      workspaceRoot: z.string(),
      authStatus: AgentStatus,
    }),
  },
  "session.listConversations": {
    params: z.object({}).optional(),
    result: z.object({ conversations: z.array(Conversation) }),
  },
  "session.createConversation": {
    params: z.object({ title: z.string().optional() }),
    result: z.object({ conversation: Conversation }),
  },
  "session.getMessages": {
    params: z.object({ conversationId: z.string() }),
    result: z.object({ messages: z.array(ChatMessage) }),
  },
  // Slash commands + skills from ~/.claude and <workspace>/.claude, for
  // the composer's "/" autocomplete (Claude Code-style).
  "session.listCommands": {
    params: z.object({}).optional(),
    result: z.object({ commands: z.array(SlashCommand) }),
  },
} as const;
