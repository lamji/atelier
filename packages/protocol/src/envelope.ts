import { z } from "zod";

/** Error codes returned in failed responses. */
export const ErrorCode = z.enum([
  "UNAUTHORIZED",
  "INVALID_PARAMS",
  "NOT_FOUND",
  "CANCELLED",
  "TOOL_FAILED",
  "SDK_AUTH_REQUIRED",
  "WORKSPACE_LOCKED",
  "NOT_IMPLEMENTED",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const BridgeError = z.object({
  code: ErrorCode,
  message: z.string(),
  data: z.unknown().optional(),
});
export type BridgeError = z.infer<typeof BridgeError>;

/** Client -> agent: RPC request. */
export const ReqFrame = z.object({
  kind: z.literal("req"),
  id: z.string(),
  method: z.string(),
  params: z.unknown().optional(),
});
export type ReqFrame = z.infer<typeof ReqFrame>;

/** Agent -> client: RPC response (success or failure). */
export const ResFrame = z.object({
  kind: z.literal("res"),
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: BridgeError.optional(),
});
export type ResFrame = z.infer<typeof ResFrame>;

/** Agent -> client: progress tied to an in-flight request id. */
export const ProgressFrame = z.object({
  kind: z.literal("progress"),
  id: z.string(),
  value: z.object({
    stage: z.string().optional(),
    pct: z.number().min(0).max(100).optional(),
    message: z.string().optional(),
    chunk: z.string().optional(),
  }),
});
export type ProgressFrame = z.infer<typeof ProgressFrame>;

/** Client -> agent: cancel an in-flight request or task. */
export const CancelFrame = z.object({
  kind: z.literal("cancel"),
  id: z.string(),
});
export type CancelFrame = z.infer<typeof CancelFrame>;

/** Client -> agent: subscribe to an event topic. */
export const SubFrame = z.object({
  kind: z.literal("sub"),
  id: z.string(),
  topic: z.string(),
  filter: z.record(z.string(), z.unknown()).optional(),
  since: z.number().optional(),
});
export type SubFrame = z.infer<typeof SubFrame>;

/** Client -> agent: unsubscribe. */
export const UnsubFrame = z.object({
  kind: z.literal("unsub"),
  subId: z.string(),
});
export type UnsubFrame = z.infer<typeof UnsubFrame>;

/** Agent -> client: pushed event. */
export const EventFrame = z.object({
  kind: z.literal("event"),
  topic: z.string(),
  seq: z.number(),
  ts: z.number(),
  taskId: z.string().optional(),
  payload: z.unknown(),
});
export type EventFrame = z.infer<typeof EventFrame>;

export const ClientFrame = z.discriminatedUnion("kind", [
  ReqFrame,
  CancelFrame,
  SubFrame,
  UnsubFrame,
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

export const ServerFrame = z.discriminatedUnion("kind", [
  ResFrame,
  ProgressFrame,
  EventFrame,
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

/** WebSocket close code used when authentication fails. */
export const CLOSE_UNAUTHORIZED = 4401;
