import { z } from "zod";
import { Plan, PlanStepStatus } from "./models/plan.js";
import { Diff } from "./models/diff.js";
import { GitFlowRequest } from "./models/git.js";
import { DbApprovalRequest, DbApprovalResolved } from "./models/hooks.js";
import { UsageSnapshot } from "./models/usage.js";
import { EditImpact, ImpactRadius } from "./models/impact.js";
import { Feature, GraphNode, Lesson, RetrievalResult } from "./models/knowledge.js";
import { ContextRequestStats } from "./models/context.js";
import { ValidationKind, ValidationResult } from "./models/validation.js";
import { ProjectInfo } from "./methods/projects.js";

export const PipelineStage = z.enum([
  "understand",
  "retrieve",
  "impact",
  "plan",
  "hooks",
  "execute",
  "validate",
  "knowledge",
  "review",
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
  "review",
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
  /** Plan rate-limit usage, pushed whenever it changes. */
  "usage.updated": UsageSnapshot,
  /** Context-engineering accounting for one LLM request. */
  "context.stats": ContextRequestStats,

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
  /**
   * The conversation's working-set lock for this turn. Published whenever a
   * scope is in force — including the turns that merely inherit it — so the
   * user can see that a folder mentioned three messages ago is still the
   * only place the agent is allowed to work.
   */
  "scope.locked": z.object({
    /** Locked project directories, workspace-relative. */
    roots: z.array(z.string()),
    /** Files this conversation is already working on, newest first. */
    anchors: z.array(z.string()).default([]),
    /**
     * Whether this turn set the lock (a mention, or a caller that already
     * knew the project) or inherited an earlier one.
     */
    source: z.enum(["mention", "explicit", "inherited", "none"]),
    /** True when this turn's mentions moved the lock somewhere new. */
    changed: z.boolean().default(false),
    /** Checkout git was pointed at, when the lock resolved to one. */
    repo: z.string().nullable().default(null),
  }),
  /**
   * Provider-neutral session memory carried into this turn's prompt. Published
   * on every turn that recalls anything, so switching model/provider shows the
   * same visible evidence as knowledge retrieval and impact analysis.
   */
  "session.recalled": z.object({
    /** Session-memory chunks RAG surfaced for this conversation. */
    chunks: z.number(),
    /** Compressed task summaries replayed in the memory block. */
    summaries: z.number(),
    /** Prior user/assistant turns replayed verbatim in the memory block. */
    turns: z.number(),
    /** Approximate token cost of everything above. */
    tokens: z.number(),
    /** Short labels for the recalled work, newest first. */
    labels: z.array(z.string()).default([]),
  }),
  // Only skills the user invoked explicitly (leading slash command).
  "skills.selected": z.object({
    skills: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
  "impact.analyzed": z.object({
    affectedFiles: z.array(z.string()),
    affectedSymbols: z.array(z.string()),
    riskNotes: z.array(z.string()).default([]),
    /** Same-unit files (template/class/spec) that no import edge links. */
    companionFiles: z.array(z.string()).default([]),
  }),
  /** Pre-edit blast radius: reach, flows, tests, and regression level. */
  "impact.radius": ImpactRadius,
  /** Symbol-level impact at a specific edit site (who uses this line). */
  "edit.impact": EditImpact,
  /** Post-edit consistency sweep by an independent reviewer agent. */
  "review.checked": z.object({
    changedFiles: z.array(z.string()),
    /** Untouched files whose code closely resembles a change. */
    similar: z
      .array(
        z.object({
          path: z.string(),
          symbol: z.string().optional(),
          score: z.number(),
          resembles: z.string(),
        })
      )
      .default([]),
    companionFiles: z.array(z.string()).default([]),
    /** pass/fail verdict from this review attempt. */
    verdict: z.enum(["pass", "fail"]).optional(),
    /** 1-based review attempt number (a fail triggers a fix + re-review). */
    attempt: z.number().optional(),
    findings: z.array(z.string()).default([]),
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
  /** A database operation is parked until the user answers in the UI. */
  "db.approval.requested": DbApprovalRequest,
  "db.approval.resolved": DbApprovalResolved,

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
  /** The agent tried to commit/push/open a PR — the user must confirm. */
  "git.flow.requested": GitFlowRequest,

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
  /** Progress of a route→feature scan. */
  "knowledge.features.scan": z.object({
    phase: z.enum(["discover", "summarize", "done"]),
    done: z.number(),
    total: z.number(),
    /** The route currently being summarized. */
    current: z.string().optional(),
  }),
  "knowledge.lesson.saved": z.object({
    lesson: Lesson,
    /** true when the save merged into an existing similar lesson. */
    merged: z.boolean().default(false),
  }),

  // task lifecycle
  "task.started": z.object({ conversationId: z.string(), prompt: z.string() }),
  "task.completed": z.object({
    conversationId: z.string(),
    durationMs: z.number(),
  }),
  "task.cancelled": z.object({ conversationId: z.string() }),
  "task.error": z.object({ conversationId: z.string(), message: z.string() }),

  // supervisor / projects
  /** A project's agent changed lifecycle state (started, stopped, crashed). */
  "project.status": z.object({ project: ProjectInfo }),
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
