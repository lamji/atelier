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

/**
 * Words too common to ground anything. Generic programming English is here
 * too — "render", "component", "value" — because a query is refused on its
 * UNKNOWN words, and a turn was seen refused for `renders currently passed`
 * where the only real term was grounded and the rest was the model
 * describing its search in prose.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "not", "any",
  "all", "you", "your", "are", "was", "were", "has", "have", "had", "but",
  "can", "will", "should", "would", "could", "there", "here", "what", "when",
  "where", "which", "who", "how", "why", "its", "it's", "then", "than",
  "use", "using", "used", "make", "made", "get", "set", "new", "old",
  // Generic English the model narrates a search with.
  "render", "renders", "rendered", "rendering", "display", "displays",
  "displayed", "displaying", "show", "shows", "showing", "shown", "pass",
  "passed", "passes", "passing", "handle", "handles", "handled", "handling",
  "handler", "handlers", "variable", "variables", "value", "values",
  "current", "currently", "need", "needs", "needed", "missing", "whether",
  "selector", "selectors", "component", "components", "function",
  "functions", "method", "methods", "file", "files", "code", "check",
  "checks", "checked", "checking", "find", "finds", "finding", "found",
  "look", "looks", "looking", "called", "calling", "call", "calls",
  "return", "returns", "returned", "returning", "real", "actual", "also",
  "about", "after", "before", "again", "because", "being", "been", "both",
  "does", "doing", "done", "each", "else", "every", "just", "like", "more",
  "most", "much", "must", "only", "other", "over", "same", "some", "such",
  "still", "take", "takes", "text", "them", "these", "they", "those",
  "through", "under", "until", "very", "want", "wants", "well", "while",
  "work", "works", "working", "did", "lets", "our", "out",
  "own", "see", "sees", "seen", "seeing", "may", "might", "one", "two",
  "way", "yet", "add", "adds", "added", "adding", "change", "changes",
  "changed", "changing", "update", "updates", "updated", "updating", "fix",
  "fixes", "fixed", "fixing", "define", "defines", "defined", "definition",
  "declare", "declares", "declared", "declaration", "import", "imports",
  "imported", "export", "exports", "exported", "class", "classes", "type",
  "types", "string", "strings", "number", "object", "objects", "array",
  "list", "item", "items", "element", "elements", "prop", "props", "state",
  "data", "field", "fields", "label", "labels", "message", "messages",
  "page", "pages", "view", "views", "button", "buttons", "input", "inputs",
  "form", "forms", "name", "names", "line", "lines", "block",
  "true", "false", "null", "undefined", "void", "const", "var", "let",
  "async", "await", "default", "static", "public", "private", "readonly",
]);

/** Below this a token is punctuation or a variable name fragment. */
const MIN_TOKEN = 3;

/** A stem shorter than this is too ambiguous to compare on. */
const MIN_STEM = 3;

/** Vocabulary entries per task; a big turn reads a lot. */
const MAX_VOCAB = 40_000;

/**
 * Tools whose query is prose. `retrieve_knowledge` is a semantic search:
 * "how the budget alert copy is rendered" is a fine query even when half
 * its words are new, so it is refused only when NOTHING in it is known.
 * The text searches keep the strict rule: a grep for one unknown word
 * scans the whole repo for it.
 */
const PROSE_TOOLS = new Set(["retrieve_knowledge"]);

/** Exact source words, including identifiers and non-English labels. */
function literalTerms(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_$]+/gu) ?? [];
}

/**
 * Words the turn has actually seen: the request, the context it was sent,
 * and everything its tools have returned.
 */
export function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(
      (token) =>
        token.length >= MIN_TOKEN &&
        !STOPWORDS.has(token) &&
        !STOPWORDS.has(stemOf(token))
    );
}

/**
 * Light stemming so `labels` grounds `label` and `rendered` grounds
 * `rendering`. Deliberately crude — one plural pass, one suffix pass, a
 * trailing `e` — and applied to BOTH sides, so what matters is that two
 * inflections of one word land on the same string, not that the string is
 * a real stem. Over-merging only ever lets a search through, which is the
 * cheap direction: this guard is a speed bump, and a false refusal costs a
 * round trip while a false pass costs a grep.
 */
export function stemOf(token: string): string {
  let stem = token;
  if (stem.endsWith("ies") && stem.length - 3 >= MIN_STEM) {
    stem = stem.slice(0, -3) + "y";
  } else if (/(ss|x|z|ch|sh)es$/.test(stem) && stem.length - 2 >= MIN_STEM) {
    stem = stem.slice(0, -2);
  } else if (stem.endsWith("s") && !stem.endsWith("ss") && stem.length - 1 >= MIN_STEM) {
    stem = stem.slice(0, -1);
  }
  for (const suffix of ["ing", "ed", "er"]) {
    if (stem.endsWith(suffix) && stem.length - suffix.length >= MIN_STEM) {
      stem = stem.slice(0, -suffix.length);
      break;
    }
  }
  if (stem.endsWith("e") && stem.length - 1 >= MIN_STEM + 1) {
    stem = stem.slice(0, -1);
  }
  return stem;
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
 * session memory), or something a tool has already returned. A text query
 * containing unseen words is blocked with guidance to discover real names.
 *
 * Text searches require observed terms. Unknown identifiers are discovered
 * by listing directories and reading source, then following those results.
 * Semantic queries keep their advisory behavior for non-agent callers.
 */
export class SearchGroundingGuard {
  /** taskId → every word this turn has seen. */
  private vocab = new Map<string, Set<string>>();
  private literals = new Map<string, Set<string>>();
  /** taskId → queries already noted once; the note is not repeated. */
  private noted = new Map<string, Set<string>>();

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
      this.literals.set(taskId, new Set());
      if (this.vocab.size > MAX_TASKS) {
        const oldest = this.vocab.keys().next().value;
        if (oldest !== undefined) {
          this.vocab.delete(oldest);
          this.literals.delete(oldest);
          this.noted.delete(oldest);
        }
      }
    }
    const literals = this.literals.get(taskId)!;
    for (const term of literalTerms(text)) literals.add(term);
    if (words.size >= MAX_VOCAB) return;
    // Both the word and its stem are kept, so a query is compared both
    // ways: `labels` finds a seen `label`, `label` finds a seen `labels`.
    for (const token of tokensOf(text)) {
      words.add(token);
      words.add(stemOf(token));
      if (words.size >= MAX_VOCAB) return;
    }
  }

  /** The turn is over; its words are no longer anyone's business. */
  release(taskId: string): void {
    this.vocab.delete(taskId);
    this.literals.delete(taskId);
    this.noted.delete(taskId);
  }

  /**
   * Text searches are blocked until their terms have appeared in context.
   * Repeating an unknown query does not bypass the check.
   */
  async check(ctx: HookGuardContext): Promise<HookDecision | undefined> {
    const note = this.ungroundedNote(ctx);
    if (!note) return undefined;
    if (!PROSE_TOOLS.has(ctx.toolName)) {
      this.bus.publish("hook.blocked", {
        hookId: SEARCH_GROUNDING_HOOK_ID,
        name: SEARCH_GROUNDING_HOOK_NAME,
        reason: note,
      }, ctx.taskId);
      return { allowed: false, reason: note };
    }
    this.bus.publish(
      "hook.completed",
      {
        hookId: SEARCH_GROUNDING_HOOK_ID,
        name: SEARCH_GROUNDING_HOOK_NAME,
        output: note,
      },
      ctx.taskId
    );
    return undefined;
  }

  /** The advisory line for an ungrounded query, or null when it is fine. */
  ungroundedNote(ctx: HookGuardContext): string | null {
    if (!SEARCH_TOOLS.has(ctx.toolName)) return null;
    const query = queryOf(ctx.input);
    if (!query) return null;
    // Nothing was seeded — a caller outside the pipeline, or a turn that
    // never got its context. Judging a search against an empty vocabulary
    // would flag every one of them.
    const words = this.vocab.get(ctx.taskId);
    if (!words || !this.literals.get(ctx.taskId)?.size) return null;

    const prose = PROSE_TOOLS.has(ctx.toolName);
    const regex = (ctx.input as { regex?: boolean }).regex === true;
    const terms = prose ? tokensOf(query) : literalTerms(
      regex ? query.replace(/\\[bBdDsSwWnrt]/g, " ") : query
    );
    // A regex, a path fragment, or a single short symbol: nothing here to
    // check against.
    if (terms.length === 0) return null;
    const literals = this.literals.get(ctx.taskId)!;
    const unknown = terms.filter((term) => prose
      ? !words.has(term) && !words.has(stemOf(term))
      : !literals.has(term)
    );
    if (unknown.length === 0) return null;
    // A prose query is judged as a whole: one grounded word anchors it. A
    // single-word prose query has nothing to anchor it against.
    if (PROSE_TOOLS.has(ctx.toolName)) {
      if (terms.length < 2 || unknown.length < terms.length) return null;
    }

    const key = query.toLowerCase();
    const already = this.noted.get(ctx.taskId);
    if (PROSE_TOOLS.has(ctx.toolName) && already?.has(key)) return null;
    if (already) already.add(key);
    else this.noted.set(ctx.taskId, new Set([key]));

    return (
      `"${query}" is not grounded: ` +
      (unknown.length === terms.length
        ? "none of its words"
        : `"${unknown.join('", "')}"`) +
      " appear in the request, in the context given, or in anything read " +
      "this turn. Copy a term from that evidence, or use list_dir and " +
      "read_file to discover the actual names before searching."
    );
  }
}

function queryOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const query = (input as { query?: unknown }).query;
  return typeof query === "string" && query.trim() ? query.trim() : null;
}
