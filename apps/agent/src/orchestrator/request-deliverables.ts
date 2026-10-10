import { stripHiddenContext } from "@atelier/shared";
import { stemOf, tokensOf } from "../hooks/search-grounding-guard.js";

/**
 * The separately deliverable items a request names.
 *
 * A turn was given a five-part design — a Tree-sitter indexer on app load,
 * a watcher, an in-app MCP+RAG retriever, reading-gate hooks, an impact
 * radius — and delivered a two-file edit to a system-prompt string, then
 * reported "live Tree-sitter index → in-app MCP RAG → … → verification"
 * as done. Nothing in the pipeline compared what was asked with what the
 * plan set out to do, so the narrowing was invisible until the user read
 * the diff. This module is the comparison: it pulls the items out of a
 * list-shaped request so `set_plan` can be held to them.
 *
 * Deliberately shallow. It reads bullets, numbered items and arrow-chain
 * stages; it does not try to understand a paragraph. A single-sentence
 * request yields nothing, and nothing is then checked — the gate only
 * exists for requests whose shape already says "several things".
 */

/** A bullet, a nested "--" item, a numbered item, or a quoted ">" line. */
const LIST_LINE = /^\s*(?:[-*•]+|\d+[.)]|>+)\s+(.+?)\s*$/;

/** Stage separators inside one line: "prompt -> rag -> llm". */
const ARROW = /\s*(?:->|→|=>)\s*/;

/** Lines that illustrate rather than ask: "ex: fix the login button". */
const EXAMPLE = /^\s*(?:ex|e\.g|eg|example|for example|i\.e)[.:]/i;

/** Bracketed asides inside an item are elaboration, not a second item. */
const ASIDE = /\[[^\]]*\]|\([^)]*\)/g;

/** Fewer content words than this and the line is not a deliverable. */
const MIN_TOKENS = 2;

/** Items past this are a request that should have been split. */
const MAX_ITEMS = 16;

/** Longest item kept verbatim; the model sees these back in the refusal. */
const ITEM_CHARS = 120;

/**
 * Fraction of an item's DISTINCTIVE words a plan must mention to count as
 * covering it. Words shared by several items ("tree sitter" in four of
 * five) are the request's theme, and a plan that only repeats the theme
 * has not taken any one item on: "keep the Tree-sitter index updated"
 * is covered by a step that says "watcher", not by a goal that says
 * "Tree-sitter" and nothing else.
 */
const COVERAGE = 0.5;

export function extractDeliverables(prompt: string): string[] {
  const human = stripHiddenContext(prompt);
  const items: string[] = [];
  const seen = new Set<string>();
  for (const line of human.split(/\r?\n/)) {
    const match = LIST_LINE.exec(line);
    if (!match?.[1]) continue;
    if (EXAMPLE.test(match[1])) continue;
    for (const stage of match[1].split(ARROW)) {
      const item = clean(stage);
      if (!item || EXAMPLE.test(item)) continue;
      if (tokensOf(item).length < MIN_TOKENS) continue;
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
      if (items.length >= MAX_ITEMS) return items;
    }
  }
  return items;
}

/**
 * The requested items no line of `planText` accounts for. `planText` is
 * the goal, every step's title/detail/files and any explicit not-covered
 * declaration, joined — so a plan covers an item by naming it anywhere,
 * including in the list of things it will NOT do.
 */
export function uncoveredDeliverables(
  deliverables: string[],
  planText: string
): string[] {
  const vocab = new Set<string>();
  for (const token of tokensOf(planText)) {
    vocab.add(token);
    vocab.add(stemOf(token));
  }
  const stems = deliverables.map((item) => stemsOf(item));
  // How many items each stem occurs in; a stem in two or more is theme.
  const spread = new Map<string, number>();
  for (const itemStems of stems) {
    for (const stem of itemStems) {
      spread.set(stem, (spread.get(stem) ?? 0) + 1);
    }
  }
  return deliverables.filter((item, index) => {
    const own = stems[index] ?? new Set<string>();
    const distinctive = [...own].filter((stem) => spread.get(stem) === 1);
    // An item made only of theme words is judged on all of them.
    const judged = distinctive.length > 0 ? distinctive : [...own];
    return !covered(judged, vocab);
  });
}

function stemsOf(text: string): Set<string> {
  return new Set(tokensOf(text).map((token) => stemOf(token)));
}

function covered(stems: string[], vocab: Set<string>): boolean {
  if (stems.length === 0) return true;
  const hits = stems.filter((stem) => vocab.has(stem)).length;
  return hits / stems.length >= COVERAGE;
}

function clean(text: string): string {
  const stripped = text
    .replace(ASIDE, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s:;,.-]+|[\s:;,.-]+$/g, "")
    .trim();
  return stripped.length > ITEM_CHARS
    ? stripped.slice(0, ITEM_CHARS - 1) + "…"
    : stripped;
}
