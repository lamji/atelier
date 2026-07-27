import { z } from "zod";

/** Which LLM call an assembled context fed. */
export const ContextPurpose = z.enum([
  "execute",
  "review",
  "fix",
  "understand",
  "plan",
]);
export type ContextPurpose = z.infer<typeof ContextPurpose>;

/** Token spend of one named section of an assembled context block. */
export const ContextSectionStat = z.object({
  name: z.string(),
  tokens: z.number(),
  items: z.number(),
});
export type ContextSectionStat = z.infer<typeof ContextSectionStat>;

/**
 * Per-request context accounting: what was assembled, what it was
 * estimated to cost, and — once the SDK result arrives — what the request
 * actually cost, with cache reads broken out separately.
 */
export const ContextRequestStats = z.object({
  requestId: z.string(),
  taskId: z.string(),
  conversationId: z.string(),
  purpose: ContextPurpose,
  sections: z.array(ContextSectionStat).default([]),
  /** Estimated tokens of the context block appended to the prompt. */
  appendTokens: z.number().default(0),
  /** Estimated cost of the pre-engineering assembly, for comparison. */
  estBaselineTokens: z.number().default(0),
  savedTokens: z.number().default(0),
  savedPct: z.number().default(0),
  /** Actuals from the SDK result message, when available. */
  actualInputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheHit: z.boolean().default(false),
  dedupedChunks: z.number().default(0),
  at: z.number(),
});
export type ContextRequestStats = z.infer<typeof ContextRequestStats>;

/** Rollup across recorded context requests. */
export const ContextTotals = z.object({
  requests: z.number(),
  actualInputTokens: z.number(),
  cacheReadTokens: z.number(),
  savedTokens: z.number(),
});
export type ContextTotals = z.infer<typeof ContextTotals>;
