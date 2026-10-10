/**
 * Clip a long turn from the middle WITHOUT losing the file references in it.
 *
 * A plan answer names its targets in the middle: "the text lives in
 * `src/i18n/translations.ts:970` and is rendered by `BudgetsTable.tsx:559`".
 * Head-and-tail clipping keeps the preamble and the closing caveat and drops
 * exactly those two lines — the next turn then implemented the caveat. The
 * refs are the cheapest and most valuable bytes in the answer, so they are
 * collected before the cut and re-attached after it.
 */

/** `path/to/file.ts:12`, `file.tsx:559-570`, `src/app.ts` — one ref. */
export const REF_PATTERN =
  /(?:[\w.-]+[\/\\])+[\w.-]+\.[a-z0-9]{1,6}(?::\d+(?:-\d+)?)?|\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|json|css|scss|md|py|go|rs|java|kt|rb|php|sql|ya?ml|toml|html|vue|svelte)(?::\d+(?:-\d+)?)?\b/g;

const MARKER = " … [middle omitted] … ";
const MAX_REF_CHARS = 200;

/** File references in `text`, in order of first appearance, deduplicated. */
export function extractRefs(text: string, cap = 12): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(REF_PATTERN)) {
    const ref = match[0].replace(/[.,;:]+$/, "");
    const key = ref.toLowerCase();
    // A bare host or version-shaped token is not a file.
    if (/^https?/i.test(ref) || /^[\d.]+$/.test(ref)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Head + tail of `text` within `maxChars`, plus a `[refs: …]` suffix naming
 * every file reference the cut removed. The suffix is budgeted out of the
 * same cap, so the result never exceeds `maxChars`.
 */
export function clipKeepingRefs(
  text: string,
  maxChars: number,
  headShare = 0.4
): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= MARKER.length + 8) return text.slice(0, maxChars);
  const plain = (n: number): { head: string; tail: string } => {
    const available = maxChars - MARKER.length - n;
    const head = Math.floor(available * headShare);
    return {
      head: text.slice(0, head),
      tail: text.slice(-(available - head)),
    };
  };
  const first = plain(0);
  const kept = new Set(
    [...extractRefs(first.head, 40), ...extractRefs(first.tail, 40)].map((r) =>
      r.toLowerCase()
    )
  );
  const lost = extractRefs(text, 40).filter((r) => !kept.has(r.toLowerCase()));
  if (lost.length === 0) return `${first.head}${MARKER}${first.tail}`;
  let suffix = ` [refs: ${lost.join(", ")}]`;
  if (suffix.length > MAX_REF_CHARS) {
    suffix = suffix.slice(0, MAX_REF_CHARS - 2) + "…]";
  }
  const { head, tail } = plain(suffix.length);
  return `${head}${MARKER}${tail}${suffix}`;
}
