import { z } from "zod";
import { AgentStatus } from "../events.js";
import { Conversation, ChatMessage } from "../models/conversation.js";

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
} as const;
