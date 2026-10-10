export const ENTRY_POINT_COMMAND_NAME = "entry_point";
export const ENTRY_POINT_COMMAND_ID =
  "project:command:" + ENTRY_POINT_COMMAND_NAME;

export const IMPACT_RADIUS_COMMAND_NAME = "impact_radius";
export const IMPACT_RADIUS_COMMAND_ID =
  "project:command:" + IMPACT_RADIUS_COMMAND_NAME;

/**
 * Returns undefined when the prompt is not the command. An empty string
 * means it was sent bare — which is the normal case, because the screenshot
 * and the page preview carry the subject.
 *
 * Both spellings are accepted for each: `/entry_point` and `/entry-point`
 * are the same command, and either is a natural thing to type.
 */
export function parseEntryPointCommand(prompt: string): string | undefined {
  return parseScreenCommand(/^\/entry[_-]?point(?:\s+([^]*))?$/i, prompt);
}

export function parseImpactRadiusCommand(prompt: string): string | undefined {
  return parseScreenCommand(/^\/impact[_-]?radius(?:\s+([^]*))?$/i, prompt);
}

/**
 * The prompt a command arrives in also carries the hidden preview block and
 * the screenshot's source URL, appended by the composer. Only the first
 * line is the command; the rest is evidence and must survive.
 */
function parseScreenCommand(
  pattern: RegExp,
  prompt: string
): string | undefined {
  const trimmed = prompt.trim();
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
  const match = pattern.exec(firstLine.trim());
  if (!match) return undefined;
  return (match[1] ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
}

/** What a marked screenshot tells us about the screen it came from. */
export interface ScreenEvidence {
  /** Route path of the previewed page, e.g. "/budgets-and-alerts". */
  route: string | null;
  /** Path segments of the route, which are usually named like the code. */
  routeTerms: string[];
  /** Headings, button labels, and visible strings lifted from the DOM. */
  labels: string[];
  /** Whether a page preview actually rode along with this send. */
  hasPreview: boolean;
}

/**
 * Route segments that identify nothing: api plumbing and versions, plus the
 * joining words a slugged route keeps — `/budgets-and-alerts` is about
 * budgets and alerts, and never about "and".
 */
const NOISE_SEGMENTS = new Set([
  "api", "v1", "v2", "app", "index", "home", "www", "public", "static",
  "and", "or", "the", "of", "for", "to", "with", "new", "edit", "list",
]);

const MAX_LABELS = 24;
const MAX_LABEL_CHARS = 48;

/**
 * Reads the screen out of a send, without needing the model to look at the
 * picture.
 *
 * This is the whole reason these two commands work the same on Codex as on
 * Claude. The composer already attaches, alongside the image, the live
 * page's URL and a compacted DOM of exactly what the user was looking at —
 * so the screen can be identified from text the agent already has, rather
 * than from vision the provider may not offer. The image still rides along
 * for the model to reason over; it is simply not what the mapping depends
 * on.
 */
export function readScreenEvidence(prompt: string): ScreenEvidence {
  const route = firstMatch(prompt, [
    /Current page preview URL:\s*(\S+)/i,
    /^\s*URL:\s*(\S+)/im,
    /CURRENT PAGE PREVIEW[^\n]*\n\s*(\S+)/i,
  ]);
  const labels = [
    ...headingLabels(prompt),
    ...interactiveLabels(prompt),
  ];
  return {
    route,
    routeTerms: routeTerms(route),
    labels: [...new Set(labels)].slice(0, MAX_LABELS),
    hasPreview:
      /CURRENT PAGE PREVIEW/i.test(prompt) ||
      /Current page preview URL:/i.test(prompt),
  };
}

/**
 * Segments of the route, which is the strongest signal there is: a page at
 * `/budgets-and-alerts` is nearly always rendered by something named for
 * those words, and a router file maps one to the other explicitly.
 */
function routeTerms(route: string | null): string[] {
  if (!route) return [];
  let path = route;
  try {
    path = new URL(route).pathname;
  } catch {
    // Not absolute — already a path, or something we can still split.
  }
  return [
    ...new Set(
      path
        .split(/[/?#]/)
        .flatMap((segment) => segment.split(/[-_.]/))
        .map((segment) => segment.toLowerCase().trim())
        .filter(
          (segment) =>
            segment.length >= 3 &&
            !NOISE_SEGMENTS.has(segment) &&
            // A uuid or numeric id names an instance, never a screen.
            !/^\d+$/.test(segment) &&
            !/^[0-9a-f]{8,}$/i.test(segment)
        )
    ),
  ].slice(0, 6);
}

/** Text inside heading tags of the captured DOM. */
function headingLabels(prompt: string): string[] {
  const labels: string[] = [];
  const heading = /<h[1-4][^>]*>([^<]{2,})<\/h[1-4]>/gi;
  for (const match of prompt.matchAll(heading)) {
    const text = cleanLabel(match[1] ?? "");
    if (text) labels.push(text);
  }
  return labels;
}

/**
 * The interactive-element list the preview capture writes, which is where a
 * button's visible words live. Its exact layout belongs to preview-context
 * on the web side, so this reads it loosely: any quoted or bracketed run of
 * words on a line that names an element.
 */
function interactiveLabels(prompt: string): string[] {
  const labels: string[] = [];
  const line = /^\s*[-*]?\s*(?:<)?(?:button|a|input|link|tab|nav)\b[^\n]*$/gim;
  for (const match of prompt.match(line) ?? []) {
    for (const quoted of match.matchAll(/["“]([^"”]{2,})["”]/g)) {
      const text = cleanLabel(quoted[1] ?? "");
      if (text) labels.push(text);
    }
  }
  return labels;
}

function cleanLabel(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_CHARS);
  // A label of pure punctuation or a lone icon glyph names nothing.
  return /[a-z0-9]/i.test(text) ? text : "";
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1]?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * Search terms for the tree-sitter index, best signal first: the route,
 * then what the screen says of itself, then anything the user typed after
 * the command.
 */
export function screenTerms(
  evidence: ScreenEvidence,
  hint: string
): string[] {
  const fromLabels = evidence.labels
    .flatMap((label) => label.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])
    .slice(0, 12);
  const fromHint = hint.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  return [...new Set([...evidence.routeTerms, ...fromHint, ...fromLabels])];
}
