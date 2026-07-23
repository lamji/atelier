import { z } from "zod";
import { Plan, PlanStepStatus } from "./models/plan.js";
import { Diff } from "./models/diff.js";
import { Feature, GraphNode, RetrievalResult } from "./models/knowledge.js";
import { ValidationKind, ValidationResult } from "./models/validation.js";

export const PipelineStage = z.enum([
  "understand",
  "retrieve",
  "impact",
  "plan",
  "hooks",
  "execute",
  "validate",
  "knowledge",
  "summary",
]);
export type PipelineStage = z.infer<typeof PipelineStage>;

export const PIPELINE_STAGES: PipelineStage[] = [
  "understand",
  "retrieve",
  "impact",
  "plan",
  "hooks",
  "execute",
  "validate",
  "knowledge",
  "summary",
];

export const AgentStatus = z.enum(["idle", "working", "waiting-auth", "error"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

/**
 * Payload schema per event topic. The EventFrame carries `topic` plus a
 * payload validated against this map on the agent side before publishing.
 */
export const eventPayloads = {
  // agent / chat
  "chat.message.delta": z.object({
    conversationId: z.string(),
    messageId: z.string(),
    delta: z.string(),
  }),
  "chat.message.completed": z.object({
    conversationId: z.string(),
    messageId: z.string(),
    text: z.string(),
  }),
  "agent.thinking.delta": z.object({
    conversationId: z.string(),
    delta: z.string(),
  }),
  "agent.status": z.object({
    status: AgentStatus,
    detail: z.string().optional(),
  }),

  // pipeline
  "pipeline.stage.started": z.object({
    stage: PipelineStage,
    detail: z.string().optional(),
  }),
  "pipeline.stage.completed": z.object({
    stage: PipelineStage,
    ok: z.boolean(),
    detail: z.string().optional(),
    durationMs: z.number(),
  }),
  "intent.resolved": z.object({
    kind: z.string(),
    summary: z.string(),
    targets: z.array(z.string()).default([]),
    constraints: z.array(z.string()).default([]),
  }),
  "knowledge.retrieved": RetrievalResult,
  "impact.analyzed": z.object({
    affectedFiles: z.array(z.string()),
    affectedSymbols: z.array(z.string()),
    riskNotes: z.array(z.string()).default([]),
  }),
  "plan.created": Plan,
  "plan.step.updated": z.object({
    planId: z.string(),
    stepId: z.string(),
    status: PlanStepStatus,
    note: z.string().optional(),
  }),

  // hooks
  "hook.matched": z.object({ hookId: z.string(), name: z.string(), on: z.string() }),
  "hook.started": z.object({ hookId: z.string(), name: z.string() }),
  "hook.completed": z.object({
    hookId: z.string(),
    name: z.string(),
    output: z.string().optional(),
  }),
  "hook.blocked": z.object({
    hookId: z.string(),
    name: z.string(),
    reason: z.string(),
  }),

  // tools
  "tool.started": z.object({
    toolCallId: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  "tool.output": z.object({ toolCallId: z.string(), chunk: z.string() }),
  "tool.completed": z.object({
    toolCallId: z.string(),
    name: z.string(),
    result: z.unknown(),
    durationMs: z.number(),
  }),
  "tool.failed": z.object({
    toolCallId: z.string(),
    name: z.string(),
    error: z.string(),
    durationMs: z.number(),
  }),

  // files / diffs
  "file.changed": z.object({
    path: z.string(),
    type: z.enum(["add", "change", "unlink"]),
    source: z.enum(["user", "agent"]),
  }),
  "diff.created": Diff,
  "edit.applied": z.object({ path: z.string(), diffId: z.string() }),

  // terminal
  "terminal.session.created": z.object({ termId: z.string(), name: z.string() }),
  "terminal.session.closed": z.object({ termId: z.string() }),
  "terminal.data": z.object({ termId: z.string(), data: z.string() }),
  "terminal.exit": z.object({ termId: z.string(), exitCode: z.number().nullable() }),

  // git
  "git.state.changed": z.object({
    branch: z.string(),
    isClean: z.boolean(),
    changedFiles: z.number(),
  }),

  // validation
  "validation.started": z.object({ kind: ValidationKind }),
  "validation.result": ValidationResult,

  // knowledge engine
  "knowledge.indexing.progress": z.object({
    phase: z.enum(["scan", "parse", "resolve", "embed", "features"]),
    done: z.number(),
    total: z.number(),
    currentPath: z.string().optional(),
  }),
  "knowledge.updated": z.object({
    files: z.array(z.string()),
    symbolsDelta: z.number(),
    edgesDelta: z.number(),
    embeddingsDelta: z.number(),
  }),
  "knowledge.feature.updated": z.object({ feature: Feature }),

  // task lifecycle
  "task.started": z.object({ conversationId: z.string(), prompt: z.string() }),
  "task.completed": z.object({
    conversationId: z.string(),
    durationMs: z.number(),
  }),
  "task.cancelled": z.object({ conversationId: z.string() }),
  "task.error": z.object({ conversationId: z.string(), message: z.string() }),
  "summary.created": z.object({
    text: z.string(),
    changedFiles: z.array(z.string()).default([]),
    validation: z.array(ValidationResult).default([]),
  }),
} as const;

export type EventTopic = keyof typeof eventPayloads;

export type EventPayload<T extends EventTopic> = z.infer<
  (typeof eventPayloads)[T]
>;

export const EVENT_TOPICS = Object.keys(eventPayloads) as EventTopic[];

/** Wildcard subscription topics: exact topic, "prefix.*", or "*". */
export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === "*" || pattern === topic) return true;
  if (pattern.endsWith(".*")) {
    return topic.startsWith(pattern.slice(0, -1));
  }
  return false;
}

export type { GraphNode };
