import { z } from "zod";
import {
  CodeSymbol,
  Feature,
  IndexStats,
  KnowledgeGraph,
  Lesson,
  RetrievalResult,
} from "../models/knowledge.js";

export const knowledgeMethods = {
  "knowledge.indexWorkspace": {
    params: z.object({ force: z.boolean().optional() }).optional(),
    result: z.object({ jobId: z.string() }),
  },
  "knowledge.retrieve": {
    params: z.object({
      query: z.string(),
      k: z.number().optional(),
      filters: z
        .object({
          pathGlob: z.string().optional(),
          kinds: z.array(z.string()).optional(),
          includeGlobalSessions: z.boolean().optional(),
        })
        .optional(),
    }),
    result: z.object({ result: RetrievalResult }),
  },
  "knowledge.graph": {
    params: z.object({
      scope: z.enum(["file", "symbol", "feature", "workspace"]),
      target: z.string().optional(),
      depth: z.number().optional(),
    }),
    result: z.object({ graph: KnowledgeGraph }),
  },
  "knowledge.features.list": {
    params: z.object({}).optional(),
    result: z.object({ features: z.array(Feature) }),
  },
  /** Scan routes/endpoints and summarize each as a feature (background). */
  "knowledge.features.scan": {
    params: z.object({}).optional(),
    result: z.object({ started: z.boolean(), routes: z.number() }),
  },
  "knowledge.lessons.list": {
    params: z.object({ limit: z.number().optional() }).optional(),
    result: z.object({ lessons: z.array(Lesson) }),
  },
  "knowledge.symbol": {
    params: z.object({ id: z.number() }),
    result: z.object({ symbol: CodeSymbol }),
  },
  "knowledge.stats": {
    params: z.object({}).optional(),
    result: z.object({ stats: IndexStats }),
  },
} as const;
