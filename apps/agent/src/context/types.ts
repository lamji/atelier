import type { RetrievedChunk } from "@atelier/protocol";

/** Compression-ladder render level: lowest sufficient level always wins. */
export type RenderLevel = 1 | 2 | 3 | 4 | 5;

/** A retrieval candidate carrying its context-engineering rank. */
export interface RankedItem {
  chunk: RetrievedChunk;
  /** Final rank after boosts/dedup — higher is better. */
  rank: number;
}

/** Token budget per section of the execute-turn context block. */
export interface ContextBudget {
  /** Ranked code items rendered through the compression ladder. */
  codeTokens: number;
  /** Bare path references for the retrieval tail. */
  refTokens: number;
  impactTokens: number;
  companionTokens: number;
  planTokens: number;
  /** "Recent work" task summaries (phase 3+). */
  summaryTokens: number;
  /** Hard ceiling for the whole assembled block. */
  totalTokens: number;
  /** Highest ladder level the top items may render at. */
  maxLevel: RenderLevel;
}

/**
 * Budgets per intent kind. Light kinds get a lean block (the model can
 * self-expand through retrieve_knowledge); edit-shaped work earns impact
 * and plan sections; feature/refactor work gets the widest window.
 */
export const BUDGETS: Record<string, ContextBudget> = {
  light: {
    codeTokens: 300,
    refTokens: 100,
    impactTokens: 0,
    companionTokens: 0,
    planTokens: 0,
    summaryTokens: 100,
    totalTokens: 500,
    maxLevel: 4,
  },
  edit: {
    codeTokens: 700,
    refTokens: 100,
    impactTokens: 250,
    companionTokens: 50,
    // The live plan remains actionable, but compact enough to leave room for
    // the exact source evidence the implementer needs.
    planTokens: 200,
    summaryTokens: 100,
    totalTokens: 1400,
    maxLevel: 5,
  },
  feature: {
    codeTokens: 1000,
    refTokens: 120,
    impactTokens: 300,
    companionTokens: 80,
    // Feature turns keep the widest allowance without carrying a second
    // near-complete copy of the repository evidence.
    planTokens: 350,
    summaryTokens: 150,
    totalTokens: 2000,
    maxLevel: 5,
  },
};

/** Max chunks that may render per source file (diversity guard). */
export const MAX_PER_PATH = 2;

/** Max session-memory chunks per turn, so recall cannot crowd out code. */
export const MAX_SESSION_MEMORY = 4;

/** Cross-session memories are opt-in, but still cannot crowd out live code. */
export const MAX_GLOBAL_SESSION_MEMORY = 4;

/** Ranked items considered for the code section before packing. */
export const MAX_CODE_CANDIDATES = 12;
