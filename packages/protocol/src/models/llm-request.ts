import { z } from "zod";
import { ContextPurpose } from "./context.js";

/** Which backend an LLM request went to. */
export const LlmProvider = z.enum(["claude", "codex", "ollama", "grok", "one-shot"]);
export type LlmProvider = z.infer<typeof LlmProvider>;

/**
 * One named block of the system context, verbatim. The order of the
 * sections is the order the model received them in.
 */
export const LlmRequestSection = z.object({
  name: z.string(),
  text: z.string(),
  tokens: z.number(),
  /** True when the stored text was cut to fit the timeline row. */
  truncated: z.boolean().default(false),
});
export type LlmRequestSection = z.infer<typeof LlmRequestSection>;

/** One message of a replayed transcript, sized but not copied. */
export const LlmTranscriptEntry = z.object({
  role: z.string(),
  chars: z.number(),
  /** Tool name for tool-result entries; the called tools for assistant. */
  label: z.string().optional(),
});
export type LlmTranscriptEntry = z.infer<typeof LlmTranscriptEntry>;

/**
 * Exactly what a model call was given, published BEFORE the call is made
 * so the timeline can be inspected even when the call never returns.
 *
 * Round 0 of a session carries the full system context and the prompt.
 * Later rounds of a tool loop (Ollama replays the whole transcript on
 * each) carry a sized transcript instead of copying every tool result
 * again, plus the same window numbers, so a request that outgrew the
 * model's context can be seen at the round it happened.
 */
export const LlmRequest = z.object({
  purpose: ContextPurpose,
  provider: LlmProvider,
  model: z.string(),
  /** 0 for the opening request of a session; tool-loop rounds count up. */
  round: z.number().default(0),
  sections: z.array(LlmRequestSection).default([]),
  prompt: z.string().default(""),
  promptTruncated: z.boolean().default(false),
  systemTokens: z.number().default(0),
  promptTokens: z.number().default(0),
  /** Estimated size of the whole request: system + prompt + transcript. */
  totalTokens: z.number().default(0),
  transcript: z.array(LlmTranscriptEntry).default([]),
  /** Number of tool schemas offered with the request. */
  toolsOffered: z.number().default(0),
  /** The context window asked for, when the transport lets us know it. */
  contextWindow: z.number().optional(),
  /** Estimated request exceeds the window: the backend will drop input. */
  overflow: z.boolean().default(false),
  /** Older tool results whose bodies Atelier elided to fit the window. */
  elided: z.number().default(0),
  /** Whether the provider resumes an earlier session for this call. */
  resumes: z.boolean().default(false),
});
export type LlmRequest = z.infer<typeof LlmRequest>;
