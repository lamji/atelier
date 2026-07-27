/**
 * Rough token estimate (~4 chars per token). Matches the heuristic the
 * knowledge indexer uses for chunks.token_count, so budgets and stored
 * counts stay comparable.
 */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
