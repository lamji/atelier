/**
 * How many tokens a turn spends carrying the conversation forward.
 *
 * The old cap was 480–600 tokens for the whole exchange, on models with a
 * 200k–1M window: the newest answer got ~190 tokens and its closing
 * recommendation — the thing the user's next message was about — fell
 * off. A CLI replaying its native transcript pays 50–250k cache-read
 * tokens per turn for the same continuity. This sits in between, on the
 * cheap side: a few thousand tokens, sized to the window it rides in.
 */
export function continuityBudgetFor(input: {
  model?: string;
  /** The last task was an ANSWER (question/plan); its text is the plan. */
  afterAnswer?: boolean;
  /**
   * The provider's context window in tokens, when known (Ollama's
   * num_ctx). Absent means a large hosted window.
   */
  window?: number;
  /** Small talk: nothing to carry beyond the last exchange. */
  trivial?: boolean;
}): number {
  if (input.trivial) return TRIVIAL_TOKENS;
  let budget = /\[1m\]/i.test(input.model ?? "") ? LARGE_WINDOW_TOKENS : BASE_TOKENS;
  if (input.afterAnswer) budget = Math.floor(budget * AFTER_ANSWER_BOOST);
  if (input.window !== undefined && Number.isFinite(input.window)) {
    budget = Math.min(budget, Math.floor(input.window * WINDOW_SHARE));
  }
  return Math.max(MIN_TOKENS, budget);
}

/** Hosted models with a ~200k window. */
export const BASE_TOKENS = 6000;
/** Models advertising a 1M window: room for the previous answer whole. */
export const LARGE_WINDOW_TOKENS = 8000;
/** The previous answer IS the plan this turn implements — keep more of it. */
const AFTER_ANSWER_BOOST = 1.25;
/** Share of a small local window the block may take. */
const WINDOW_SHARE = 0.08;
const MIN_TOKENS = 400;
const TRIVIAL_TOKENS = 600;
