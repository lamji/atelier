/**
 * Central type module. Local UI types live here; protocol types re-export
 * so views/hooks never import wire types from deep paths.
 */
export type {
  AgentStatus,
  ChatMessage,
  Conversation,
  EventFrame,
  EventTopic,
  EventPayload,
  MethodName,
  MethodParams,
  MethodResult,
  PipelineStage,
  TaskInfo,
} from "@atelier/protocol";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "handshaking"
  | "connected"
  | "unauthorized";

export interface TimelineEntryVm {
  key: string;
  topic: string;
  ts: number;
  taskId?: string;
  conversationId?: string;
  payload: unknown;
}

export interface ChatItemVm {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  /** Data-URL thumbnails of images sent with a user message. */
  images?: string[];
}
