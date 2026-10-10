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

export type ConnectionState = "disconnected" | "connecting" | "connected";

/** A rectangle normalized to an image: 0..1 on both axes, from the top-left. */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Image staged in the composer, including screenshots captured in preview. */
export interface PendingImage {
  id: string;
  mediaType: string;
  /** Base64 payload sent to the agent (no data: prefix). */
  data: string;
  /** Full data URL for the composer/message thumbnail. */
  dataUrl: string;
  /** Workspace-relative source path when the image was persisted by Atelier. */
  path?: string;
  /** Live preview URL captured with the image, including its current route. */
  sourceUrl?: string;
  /**
   * Regions the user drew on a preview screenshot. They are burned into the
   * pixels too, but the model cannot grep pixels: the composer maps these
   * onto the live iframe and asks the DOM what text sits under each one.
   */
  highlights?: NormalizedRect[];
  /**
   * The area the screenshot covers, in the preview iframe's own CSS pixels
   * (the pane scales the iframe to fit, so this is not the image size).
   * highlight × captureSize = iframe viewport coordinates.
   */
  captureSize?: { width: number; height: number };
}

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
  /** Persisted owner task; groups its request and report into one timeline. */
  taskId?: string;
  /** Submission time; this orders task timelines even when a request queued. */
  createdAt?: number;
  role: "user" | "assistant" | "log" | "diff";
  text: string;
  streaming?: boolean;
  /** Data-URL thumbnails of images sent with a user message. */
  images?: string[];
  /**
   * Source event topic for a "log" item (e.g. "knowledge.retrieved"),
   * used to pick its icon. Absent for user/assistant items.
   */
  logTopic?: string;
  /**
   * Long-form body behind a "log" line (the full context a model request
   * carried, for instance). Rendered only when the row is expanded.
   */
  logDetail?: string;
  /** File edit shown inline as a VS Code-style diff. Only set for "diff". */
  diff?: { path: string; before: string; after: string };
}
