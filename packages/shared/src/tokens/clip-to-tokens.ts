import { approxTokens } from "./approx-tokens.js";

/** Clips text to an approximate token budget, marking the cut. */
export function clipToTokens(text: string, maxTokens: number): string {
  if (approxTokens(text) <= maxTokens) return text;
  const maxChars = Math.max(0, maxTokens * 4 - 1);
  return `${text.slice(0, maxChars)}…`;
}
