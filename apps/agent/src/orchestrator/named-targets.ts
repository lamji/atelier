/**
 * What the user POINTED AT, read from their own words and the screen.
 *
 * "make this descriptive", "I can still see No budgets configured yet",
 * `'budgets.table.no_configured': '…'`, "go here: src/i18n/translations.ts"
 * — every one of these names a concrete thing, and the turn that went wrong
 * never looked at the thing named before editing somewhere else. A path is
 * a path. A quoted string is a string the user expects to find in the code.
 * A phrase that also appears on the previewed page is on-screen copy. A
 * highlighted region's text is the subject by construction.
 *
 * Deterministic and literal: nothing here guesses. The guard that consumes
 * it only asks that the named thing be LOOKED AT (read or searched) before
 * the turn plans or edits anywhere else.
 */
export interface NamedTargets {
  /** Files the user typed, as typed (line suffixes removed). */
  paths: string[];
  /** Strings the user expects to find: quoted text, i18n keys, on-screen copy. */
  literals: string[];
}

export const EMPTY_NAMED_TARGETS: NamedTargets = { paths: [], literals: [] };

const MAX_EACH = 6;

/** A path or "@mention" as typed: `src/app.ts`, `apps/web`, `Composer.tsx`. */
const PATH_TOKEN =
  /@?(?:[\w.-]+[\/\\])+[\w.-]+|@?[\w-]+\.(?:tsx?|jsx?|mjs|cjs|json|css|scss|less|md|mdx|py|go|rs|java|kt|rb|php|sql|ya?ml|toml|html|vue|svelte|prisma|graphql|env)\b/gi;

/** `"…"`, `` `…` ``, or `'…'` at a token boundary (so "doesn't" is not one). */
const DOUBLE_QUOTED = /"([^"\r\n]{3,160})"/g;
const BACKTICKED = /`([^`\r\n]{3,160})`/g;
const SINGLE_QUOTED = /(?:^|[\s(\[{:,=])'([^'\r\n]{3,160})'(?=$|[\s)\]},;.:!?])/g;

/** `budgets.table.no_configured` — a dotted key that is not a file or host. */
const DOTTED_KEY = /\b[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+){2,}\b/gi;
const HOST_TAIL = /\.(?:com|net|org|io|ai|dev|app|co|me|info|local|localhost)$/i;
const FILE_TAIL =
  /\.(?:tsx?|jsx?|mjs|cjs|json|css|scss|md|py|go|rs|java|rb|php|sql|ya?ml|toml|html|vue|svelte|png|jpe?g|svg|gif|webp)$/i;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "not", "any",
  "all", "you", "your", "are", "was", "were", "has", "have", "had", "but",
  "can", "will", "should", "would", "could", "there", "here", "what", "when",
  "where", "which", "who", "how", "why", "its", "then", "than", "see", "still",
  "please", "just", "also", "now", "yet", "one", "need", "want", "like",
]);

const MAX_PHRASE_WORDS = 8;
/** Two-word runs qualify only when BOTH words carry meaning ("Create Budget"). */
const MIN_PHRASE_WORDS = 2;

export function namedTargets(input: {
  humanPrompt: string;
  /** previewVisibleText(prompt) — the page's visible strings, one per line. */
  previewText?: string;
  /** focusedLiterals(prompt) — text inside highlighted regions. */
  focused?: string[];
}): NamedTargets {
  const human = input.humanPrompt ?? "";
  const paths = collect(pathsIn(human), MAX_EACH);
  const literals = collect(
    [
      ...(input.focused ?? []),
      ...quotedIn(human),
      ...dottedKeysIn(human),
      ...onScreenPhrases(human, input.previewText ?? ""),
    ],
    MAX_EACH
  );
  // A quoted string that is itself a path belongs on the path side.
  const pathLike = new Set(paths.map((p) => p.toLowerCase()));
  return {
    paths,
    literals: literals.filter((l) => !pathLike.has(l.toLowerCase())),
  };
}

function pathsIn(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(PATH_TOKEN)) {
    const raw = match[0];
    const prefix = text.slice(0, match.index);
    // Anything inside a URL (`http://host:8080/workspace`) is an address,
    // not a file the user named — whatever segment the pattern landed on.
    if (/[a-z][a-z0-9+.-]*:\/\/\S*$/i.test(prefix)) continue;
    if (/^https?$/i.test(raw) || /^[\d.]+$/.test(raw)) continue;
    if (/^\d+[\/\\]/.test(raw)) continue;
    const path = raw
      .replace(/^@/, "")
      .replace(/[.,;:!?)]+$/, "")
      .replace(/:\d+(?:-\d+)?$/, "");
    if (!path.includes("/") && !path.includes("\\") && !FILE_TAIL.test(path)) {
      continue;
    }
    out.push(path);
  }
  return out;
}

function quotedIn(text: string): string[] {
  const out: string[] = [];
  for (const re of [DOUBLE_QUOTED, BACKTICKED, SINGLE_QUOTED]) {
    for (const match of text.matchAll(re)) {
      const inner = match[1]!.trim();
      if (inner.length >= 3) out.push(inner);
    }
  }
  return out;
}

function dottedKeysIn(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(DOTTED_KEY)) {
    const key = match[0];
    const before = text.slice(Math.max(0, match.index! - 4), match.index);
    if (before.endsWith("://") || before.endsWith("www.")) continue;
    if (HOST_TAIL.test(key) || FILE_TAIL.test(key)) continue;
    out.push(key);
  }
  return out;
}

/**
 * Runs of the user's words that appear verbatim on the previewed page —
 * the label they are looking at, named without quotes. Longest runs win;
 * a run inside a longer accepted run is dropped.
 */
export function onScreenPhrases(human: string, previewText: string): string[] {
  if (!previewText.trim()) return [];
  const screen = ` ${previewText.replace(/\s+/g, " ").toLowerCase()} `;
  const words = human.replace(/\s+/g, " ").split(" ").filter(Boolean);
  const accepted: string[] = [];
  for (let size = MAX_PHRASE_WORDS; size >= MIN_PHRASE_WORDS; size--) {
    for (let i = 0; i + size <= words.length; i++) {
      const slice = words.slice(i, i + size);
      const phrase = slice.join(" ").replace(/^[^\w"']+|[^\w"'.!?]+$/g, "");
      const lower = phrase.toLowerCase();
      if (!lower || accepted.some((a) => a.toLowerCase().includes(lower))) {
        continue;
      }
      const isMeaningful = (w: string): boolean =>
        w.length >= 3 && !STOPWORDS.has(w.toLowerCase().replace(/[^\w]/g, ""));
      const meaningful =
        size === 2
          ? slice.every(isMeaningful)
          : slice.some((w) => w.length >= 4 && isMeaningful(w));
      if (!meaningful) continue;
      if (screen.includes(` ${lower} `) || screen.includes(` ${lower}.`)) {
        accepted.push(phrase);
      }
    }
  }
  return accepted;
}

function collect(values: string[], cap: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const clean = value.trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= cap) break;
  }
  return out;
}

/** One line naming the targets, for prompts and hook reasons. */
export function describeNamedTargets(targets: NamedTargets): string {
  const parts: string[] = [];
  if (targets.paths.length > 0) parts.push(`file(s) ${targets.paths.join(", ")}`);
  if (targets.literals.length > 0) {
    parts.push(`text ${targets.literals.map((l) => `"${l}"`).join(", ")}`);
  }
  return parts.join(" and ");
}
