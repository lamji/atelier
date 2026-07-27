import { z } from "zod";

export const SymbolKind = z.enum([
  "function",
  "class",
  "method",
  "interface",
  "type",
  "enum",
  "variable",
  "constant",
  "component",
  "hook",
  "route",
  "module",
  "unknown",
]);
export type SymbolKind = z.infer<typeof SymbolKind>;

export const CodeSymbol = z.object({
  id: z.number(),
  path: z.string(),
  name: z.string(),
  kind: SymbolKind,
  signature: z.string().optional(),
  parentId: z.number().nullable().optional(),
  startRow: z.number(),
  startCol: z.number(),
  endRow: z.number(),
  endCol: z.number(),
  docComment: z.string().optional(),
});
export type CodeSymbol = z.infer<typeof CodeSymbol>;

export const GraphNode = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string(),
  path: z.string().optional(),
  /** Container node id (symbols nest inside their file's group node). */
  parentId: z.string().optional(),
});
export type GraphNode = z.infer<typeof GraphNode>;

export const GraphEdge = z.object({
  source: z.string(),
  target: z.string(),
  kind: z.enum(["import", "call", "ref", "feature", "lesson"]),
});
export type GraphEdge = z.infer<typeof GraphEdge>;

export const KnowledgeGraph = z.object({
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge),
});
export type KnowledgeGraph = z.infer<typeof KnowledgeGraph>;

export const Feature = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string(),
  summary: z.string(),
  detailMd: z.string().optional(),
  status: z.enum(["fresh", "stale", "building"]),
  updatedAt: z.number(),
  files: z.array(z.string()).default([]),
});
export type Feature = z.infer<typeof Feature>;

export const LessonKind = z.enum(["bug-fix", "gotcha", "pattern", "preference"]);
export type LessonKind = z.infer<typeof LessonKind>;

/**
 * Episodic knowledge: a distilled, reusable insight from past work (a
 * confirmed bug fix, a gotcha, a proven pattern). Stored tiny (~100
 * tokens), linked to symbols/files, retrieved only when relevant.
 */
export const Lesson = z.object({
  id: z.number(),
  title: z.string(),
  body: z.string(),
  kind: LessonKind,
  confidence: z.number(),
  useCount: z.number(),
  createdAt: z.number(),
  /** Symbol names / file paths this lesson is anchored to. */
  links: z.array(z.string()).default([]),
});
export type Lesson = z.infer<typeof Lesson>;

export const RetrievedChunk = z.object({
  id: z.number(),
  path: z.string(),
  kind: z.enum(["code", "doc", "feature-summary", "lesson"]),
  score: z.number(),
  preview: z.string(),
  startRow: z.number().optional(),
  endRow: z.number().optional(),
  /** Enrichment for context engineering (ranking, budgeting, dedup). */
  symbolId: z.number().optional(),
  tokenCount: z.number().optional(),
  contentHash: z.string().optional(),
  /** Per-arm retrieval scores before the weighted merge. */
  arms: z
    .object({ vec: z.number(), kw: z.number(), sym: z.number() })
    .optional(),
});
export type RetrievedChunk = z.infer<typeof RetrievedChunk>;

export const RetrievalResult = z.object({
  strategy: z.string(),
  chunks: z.array(RetrievedChunk),
  graphNodes: z.array(GraphNode).default([]),
  features: z.array(Feature).default([]),
});
export type RetrievalResult = z.infer<typeof RetrievalResult>;

export const IndexStats = z.object({
  files: z.number(),
  symbols: z.number(),
  edges: z.number(),
  chunks: z.number(),
  embedded: z.number(),
  features: z.number(),
  lessons: z.number().default(0),
  /** Files still queued for (re)indexing; > 0 means indexing is active. */
  queued: z.number().default(0),
  lastIndexedAt: z.number().nullable(),
});
export type IndexStats = z.infer<typeof IndexStats>;
