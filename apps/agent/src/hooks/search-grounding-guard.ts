import type { EventBus } from "../events/event-bus.js";
import type { HookDecision, HookGuardContext } from "./hooks-engine.js";

export const SEARCH_GROUNDING_HOOK_ID = "builtin-search-grounding";
export const SEARCH_GROUNDING_HOOK_NAME = "Search terms must come from the turn";

/** Tools whose query is a string the model chose. */
export const SEARCH_GROUNDING_MATCHER =
  "retrieve_knowledge|search_text|search_workspace";
const SEARCH_TOOLS = new Set(SEARCH_GROUNDING_MATCHER.split("|"));

/** Tasks kept in the ledger; old ones are dropped oldest-first. */
const MAX_TASKS = 32;

/** Words too common to ground anything. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "not", "any",
  "all", "you", "your", "are", "was", "were", "has", "have", "had", "but",
  "can", "will", "should", "would", "could", "there", "here", "what", "when",
  "where", "which", "who", "how", "why", "its", "it's", "then", "than",
  "use", "using", "used", "make", "made", "get", "set", "new", "old",
]);

/** Below this a token is punctuation or a variable name fragment. */
const MIN_TOKEN = 3;

/** Vocabulary entries per task; a big turn reads a lot. */
const MAX_VOCAB = 40_000;

/**
 * Words the turn has actually seen: the request, the context it was sent,
 * and everything its tools have returned.
 */
export function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length >= MIN_TOKEN && !STOPWORDS.has(token));
}

/**
 * Keeps the model searching for things that exist.
 *
 * A turn was observed grepping a VS Code fork for "DIRECT EXECUTION" and
 * "ACTIVE WORKFLOW" — two rule-heading-shaped phrases that appear nowhere
 * in the workspace, in any skill, or in Atelier's own rules. The model had
 * been asked to fix the chat timeline; with nothing concrete to go on it
 * invented plausible-looking identifiers and went looking for them. Each
 * one cost a full-repo scan and returned nothing, and the turn ended with
 * no report.
 *
 * So a search term now has to come from somewhere: the user's own words,
 * the context this turn was given (retrieved chunks, the directory map,
 * session memory), or something a tool has already returned. A query whose
 * every meaningful word is unknown to the turn is refused once, and the
 * refusal says what to search for instead.
 *
 * It is a speed bump, not a wall — deliberately. The model can be right
 * about a hunch the vocabulary has not heard of yet, so repeating the same
 * search goes through. What the bump removes is the reflex.
 */
export class SearchGroundingGuard {
  /** taskId → every word this turn has seen. */
  private vocab = new Map<string, Set<string>>();
  /** taskId → queries already refused once. */
  private refused = new Map<string, Set<string>>();

  constructor(private bus: EventBus) {}

  /** Seeds the turn's vocabulary — the prompt and its assembled context. */
  seed(taskId: string, texts: string[]): void {
    this.note(taskId, texts.join("\n"));
  }

  /** Adds whatever a tool just returned; results ground later searches. */
  note(taskId: string, text: string): void {
    if (!text) return;
    let words = this.vocab.get(taskId);
    if (!words) {
      words = new Set<string>();
      this.vocab.set(taskId, words);
      if (this.vocab.size > MAX_TASKS) {
        const oldest = this.vocab.keys().next().value;
        if (oldest !== undefined) {
          this.vocab.delete(oldest);
          this.refused.delete(oldest);
        }
      }
    }
    if (words.size >= MAX_VOCAB) return;
    for (const token of tokensOf(text)) {
      words.add(token);
      if (words.size >= MAX_VOCAB) return;
    }
  }

  /** The turn is over; its words are no longer anyone's business. */
  release(taskId: string): void {
    this.vocab.delete(taskId);
    this.refused.delete(taskId);
  }

  async check(ctx: HookGuardContext): Promise<HookDecision | undefined> {
    if (!SEARCH_TOOLS.has(ctx.toolName)) return undefined;
    const query = queryOf(ctx.input);
    if (!query) return undefined;
    // Nothing was seeded — a caller outside the pipeline, or a turn that
    // never got its context. Judging a search against an empty vocabulary
    // would refuse every one of them.
    const words = this.vocab.get(ctx.taskId);
    if (!words || words.size === 0) return undefined;

    const terms = tokensOf(query);
    // A regex, a path fragment, or a single short symbol: nothing here to
    // check against, and refusing it would only cost a round trip.
    if (terms.length === 0) return undefined;
    const unknown = terms.filter((term) => !words.has(term));
    if (unknown.length === 0) return undefined;

    const already = this.refused.get(ctx.taskId);
    if (already?.has(query.toLowerCase())) return undefined;
    if (already) already.add(query.toLowerCase());
    else this.refused.set(ctx.taskId, new Set([query.toLowerCase()]));

    const reason =
      `"${query}" is not grounded: ` +
      (unknown.length === terms.length
        ? "none of its words"
        : `"${unknown.join('", "')}"`) +
      " appear in the request, in the context you were given, or in " +
      "anything you have read this turn. Do not search for identifiers you " +
      "expect to exist — search the words the user actually used, a file " +
      "name from the DIRECTORY MAP, or a string you have seen in a file. " +
      "Repeat this exact search to run it anyway.";
    this.bus.publish(
      "hook.blocked",
      { hookId: SEARCH_GROUNDING_HOOK_ID, name: SEARCH_GROUNDING_HOOK_NAME, reason },
      ctx.taskId
    );
    return { allowed: false, reason };
  }
}

function queryOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const query = (input as { query?: unknown }).query;
  return typeof query === "string" && query.trim() ? query.trim() : null;
}
