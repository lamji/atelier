import { z } from "zod";
import { AgentStatus } from "../events.js";
import { Conversation, ChatMessage } from "../models/conversation.js";

/** A slash command or user-invocable skill the composer can offer. */
export const SlashCommand = z.object({
  /** Stable key: `${scope}:${kind}:${name}`. */
  id: z.string(),
  /** Invocation name without the leading slash, e.g. "annotate". */
  name: z.string(),
  description: z.string(),
  kind: z.enum(["command", "skill"]),
  scope: z.enum(["user", "project"]),
  enabled: z.boolean().default(true),
});
export type SlashCommand = z.infer<typeof SlashCommand>;

/** An MCP server the agent will load for a run. */
export const McpServerInfo = z.object({
  name: z.string(),
  /** "builtin" is Atelier's own in-process server. */
  scope: z.enum(["builtin", "user", "project"]),
  /** stdio command, or the URL for http/sse servers. */
  transport: z.string(),
  detail: z.string(),
  /** Config file it came from, "" for the built-in. */
  source: z.string(),
});
export type McpServerInfo = z.infer<typeof McpServerInfo>;

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
  "session.getCommandDetail": {
    params: z.object({ id: z.string() }),
    result: z.object({ command: SlashCommand, content: z.string() }),
  },
  "session.setCommandEnabled": {
    params: z.object({ id: z.string(), enabled: z.boolean() }),
    result: z.object({ command: SlashCommand }),
  },
  /** MCP servers from the same config files Claude Code reads. */
  "session.listMcpServers": {
    params: z.object({}).optional(),
    result: z.object({ servers: z.array(McpServerInfo) }),
  },
} as const;
