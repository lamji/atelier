import { approxTokens } from "@atelier/shared";
import type { RetrievedChunk } from "@atelier/protocol";
import type { Db } from "../../storage/db.js";
import type { ContextBudget, RenderLevel } from "../types.js";
import { renderItem } from "../render/index.js";

export interface PackedItems {
  /** Rendered code-section lines, in rank order. */
  text: string;
  tokens: number;
  items: number;
  /** Chunks that did not earn a render — surfaced as path refs instead. */
  overflow: RetrievedChunk[];
  /** Chunks rendered at preview/full detail (L4+) — dedup marks these. */
  detailed: RetrievedChunk[];
}

/**
 * Greedy ladder packing: each item starts at its tier's level (top two
 * items highest, next four the AST summary, the rest signatures) and
 * degrades level by level until it fits the remaining code budget. The
 * lowest sufficient level always wins; what cannot fit at L1 overflows
 * to the path-reference section.
 */
export function packItems(
  chunks: RetrievedChunk[],
  budget: ContextBudget,
  db: Db
): PackedItems {
  const lines: string[] = [];
  const overflow: RetrievedChunk[] = [];
  const detailed: RetrievedChunk[] = [];
  let remaining = budget.codeTokens;
  let items = 0;

  chunks.forEach((chunk, index) => {
    let level = tierLevel(index, budget.maxLevel);
    let rendered = "";
    let cost = 0;
    while (level >= 1) {
      rendered = renderItem(chunk, level as RenderLevel, db);
      cost = approxTokens(rendered);
      if (cost <= remaining) break;
      level -= 1;
    }
    if (level < 1 || cost > remaining) {
      overflow.push(chunk);
      return;
    }
    lines.push(rendered);
    remaining -= cost;
    items += 1;
    if (level >= 4) detailed.push(chunk);
  });

  const text = lines.join("\n");
  return { text, tokens: approxTokens(text), items, overflow, detailed };
}

function tierLevel(index: number, maxLevel: RenderLevel): number {
  if (index === 0) return maxLevel;
  if (index === 1) return Math.min(4, maxLevel);
  if (index < 6) return 3;
  return 1;
}
