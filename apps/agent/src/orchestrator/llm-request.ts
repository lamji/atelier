import { approxTokens, stripHiddenContext } from "@atelier/shared";
import type {
  ContextPurpose,
  LlmProvider,
  LlmRequest,
  LlmRequestSection,
  LlmTranscriptEntry,
} from "@atelier/protocol";
import type { EventBus } from "../events/event-bus.js";

/**
 * A named block of the system context. Names are what the timeline row
 * shows beside each block's size, so they should say what the block IS
 * ("rules", "session memory", "retrieved code"), not where it came from.
 */
export interface ContextSection {
  name: string;
  text: string;
}

/**
 * What callers of streamSession pass as the per-turn context: a plain
 * string (one anonymous block) or named sections. The provider receives
 * the same bytes either way — the names only feed the timeline.
 */
export type AppendContext = string | ContextSection[];

export function contextText(append: AppendContext): string {
  if (typeof append === "string") return append;
  return append
    .map((section) => section.text)
    .filter(Boolean)
    .join("\n");
}

export function contextSections(append: AppendContext): ContextSection[] {
  if (typeof append === "string") {
    return append ? [{ name: "turn context", text: append }] : [];
  }
  return append.filter((section) => section.text);
}

/**
 * Storage caps for the copies kept in the timeline. A row is read by a
 * person, and a 400 KB blob per model call would also make reconnect
 * replay drag; the token counts are always computed on the full text.
 */
const SECTION_MAX_CHARS = 60_000;
const PROMPT_MAX_CHARS = 20_000;

export interface BuildLlmRequestInput {
  purpose: ContextPurpose;
  provider: LlmProvider;
  model: string;
  round?: number;
  sections?: ContextSection[];
  prompt?: string;
  transcript?: LlmTranscriptEntry[];
  /** Characters of transcript not represented by `sections`/`prompt`. */
  transcriptChars?: number;
  toolsOffered?: number;
  contextWindow?: number;
  elided?: number;
  resumes?: boolean;
}

export const PREVIEW_MARKUP_REQUEST_RE =
  /\b(?:css|dom|html|markup|style|styles|stylesheet|stylesheets|styling|layout|class(?:es|name)?)\b/i;
/**
 * The raw markup and stylesheet sections of the hidden preview block, in
 * the tagged layout the renderer emits (`apps/web/src/services/
 * preview-context.ts`). The previous pattern matched a `HTML:` / `CSS:`
 * layout that no longer exists, so for months NOTHING was stripped and
 * every screenshot turn carried ~18K chars of markup the request never
 * asked about — enough for a model to grep a Tailwind class out of it
 * instead of the label the user pointed at.
 */
const PREVIEW_MARKUP_SECTION_RE =
  /\r?\n?\r?\n<(page-html|page-css)>\r?\n[\s\S]*?\r?\n<\/\1>/g;

/**
 * The live preview always carries the visible labels, the focused elements
 * and the console diagnostics. Raw HTML and CSS are much larger, so keep
 * them only when the visible user request explicitly asks about markup or
 * styling source.
 */
export function promptWithRelevantPreview(prompt: string): string {
  if (!prompt.includes("<page-html>") && !prompt.includes("<page-css>")) {
    return prompt;
  }
  if (PREVIEW_MARKUP_REQUEST_RE.test(stripHiddenContext(prompt))) return prompt;
  return prompt.replace(PREVIEW_MARKUP_SECTION_RE, "");
}

export function buildLlmRequest(input: BuildLlmRequestInput): LlmRequest {
  const sections: LlmRequestSection[] = (input.sections ?? [])
    .filter((section) => section.text.length > 0)
    .map((section) => ({
      name: section.name,
      text: clipStored(section.text, SECTION_MAX_CHARS),
      tokens: approxTokens(section.text),
      truncated: section.text.length > SECTION_MAX_CHARS,
    }));
  const prompt = input.prompt ?? "";
  const systemTokens = sections.reduce((sum, section) => sum + section.tokens, 0);
  const promptTokens = approxTokens(prompt);
  const transcriptTokens = approxTokens(" ".repeat(input.transcriptChars ?? 0));
  const totalTokens = systemTokens + promptTokens + transcriptTokens;
  return {
    purpose: input.purpose,
    provider: input.provider,
    model: input.model,
    round: input.round ?? 0,
    sections,
    prompt: clipStored(prompt, PROMPT_MAX_CHARS),
    promptTruncated: prompt.length > PROMPT_MAX_CHARS,
    systemTokens,
    promptTokens,
    totalTokens,
    transcript: input.transcript ?? [],
    toolsOffered: input.toolsOffered ?? 0,
    ...(input.contextWindow !== undefined
      ? { contextWindow: input.contextWindow }
      : {}),
    // A rough estimate against the exact window; the margin keeps a
    // borderline request from crying wolf.
    overflow:
      input.contextWindow !== undefined &&
      totalTokens > input.contextWindow * 0.95,
    elided: input.elided ?? 0,
    resumes: input.resumes ?? false,
  };
}

function clipStored(text: string, max: number): string {
  if (text.length <= max) return text;
  const omitted = text.length - max;
  return `${text.slice(0, max)}\n… [${omitted} more characters not stored]`;
}

/**
 * Publishes the request on the bus. Wrapped so a serialisation problem in
 * a debug event can never take the model call down with it.
 */
export function publishLlmRequest(
  bus: EventBus,
  taskId: string,
  request: LlmRequest
): void {
  try {
    bus.publish("llm.request", request, taskId);
  } catch {
    // The call proceeds; only the timeline row is missing.
  }
}
