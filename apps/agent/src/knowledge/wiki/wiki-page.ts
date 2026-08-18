import { approxTokens, clipToTokens, toPosix } from "@atelier/shared";

/**
 * One compiled feature page: what Atelier knows about a feature, written
 * once and updated in place, so a later turn reads a page instead of
 * re-deriving the feature from a dozen files.
 *
 * Markdown with YAML-ish frontmatter, Obsidian-compatible (`[[links]]`).
 * The frontmatter is deliberately flat and hand-parsed: pages are edited
 * by a model and occasionally by a person, and a strict YAML parser would
 * turn a stray colon into a lost page.
 */
export interface WikiPage {
  slug: string;
  title: string;
  aliases: string[];
  /** fresh: every source hash matches; stale: some moved; draft: unverified. */
  status: WikiStatus;
  /** Files the page's claims are anchored to, with the hash seen at write. */
  sources: WikiSource[];
  /** Slugs of related pages ([[wikilinks]] in the body are merged in). */
  links: string[];
  /** Task that last compiled/verified the page, when known. */
  verifiedBy?: string;
  updatedAt: number;
  /** Everything after the frontmatter. */
  body: string;
}

export type WikiStatus = "fresh" | "stale" | "draft";

export interface WikiSource {
  path: string;
  hash: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const WIKILINK = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

export function parseWikiPage(slug: string, content: string): WikiPage {
  const fm = FRONTMATTER.exec(content);
  const head = fm ? fm[1]! : "";
  const body = fm ? content.slice(fm[0].length) : content;
  const fields = parseFrontmatter(head);
  const title = fields.feature?.[0] ?? titleFromBody(body) ?? slug;
  const status = (fields.status?.[0] ?? "draft") as WikiStatus;
  const sources = (fields.sources ?? [])
    .map(parseSource)
    .filter((source): source is WikiSource => source !== null);
  const links = [
    ...new Set([
      ...(fields.links ?? []).map(slugify),
      ...[...body.matchAll(WIKILINK)].map((m) => slugify(m[1]!)),
    ]),
  ].filter((link) => link && link !== slug);
  const updated = Number(fields.updated?.[0]);
  return {
    slug,
    title,
    aliases: (fields.aliases ?? []).map((alias) => alias.trim()).filter(Boolean),
    status: status === "fresh" || status === "stale" ? status : "draft",
    sources,
    links,
    verifiedBy: fields.verified?.[0],
    updatedAt: Number.isFinite(updated) ? updated : 0,
    body: body.replace(/^\s*\n/, ""),
  };
}

export function serializeWikiPage(page: WikiPage): string {
  const lines = [
    "---",
    `feature: ${page.title}`,
    `slug: ${page.slug}`,
    `status: ${page.status}`,
    `updated: ${page.updatedAt}`,
  ];
  if (page.verifiedBy) lines.push(`verified: ${page.verifiedBy}`);
  if (page.aliases.length > 0) {
    lines.push("aliases:");
    for (const alias of page.aliases) lines.push(`  - ${alias}`);
  }
  if (page.links.length > 0) {
    lines.push("links:");
    for (const link of page.links) lines.push(`  - ${link}`);
  }
  if (page.sources.length > 0) {
    lines.push("sources:");
    for (const source of page.sources) {
      lines.push(`  - "${source.path} @ ${source.hash}"`);
    }
  }
  lines.push("---", "");
  return `${lines.join("\n")}${page.body.trimEnd()}\n`;
}

/**
 * The page as the model sees it at turn start: the frontmatter reduced to
 * a status line, the body clipped to the budget, and — the part that
 * matters — the sources that moved since the page was written called out
 * by name, so the model verifies exactly those and trusts the rest.
 */
export function renderWikiPageForContext(
  page: WikiPage,
  moved: string[],
  maxTokens: number
): string {
  const lines: string[] = [];
  const state =
    moved.length > 0
      ? `STALE — these sources changed since the page was verified, re-check ` +
        `the steps that cite them before relying on them: ${moved.join(", ")}`
      : page.status === "draft"
        ? "DRAFT — compiled but not yet verified against a completed task"
        : "fresh — every cited source is unchanged since verification";
  lines.push(`### [[${page.slug}]] ${page.title} (${state})`);
  if (page.aliases.length > 0) lines.push(`aliases: ${page.aliases.join(", ")}`);
  if (page.links.length > 0) {
    lines.push(`related pages: ${page.links.map((l) => `[[${l}]]`).join(", ")}`);
  }
  const head = lines.join("\n");
  const bodyBudget = Math.max(80, maxTokens - approxTokens(head));
  return `${head}\n${clipToTokens(page.body.trim(), bodyBudget)}`;
}

/** Slug rules shared by page names, links, and file names. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** Workspace-looking paths mentioned in a page body: `a/b.ts`, `src/x.tsx:12`. */
export function pathsMentioned(body: string): string[] {
  const found = new Set<string>();
  const re = /(?:^|[\s`(\[,])((?:[\w.@-]+\/)+[\w.@-]+\.[a-z0-9]{1,8})(?::\d+)?/gi;
  for (const match of body.matchAll(re)) {
    const raw = match[1]!;
    if (raw.startsWith("http") || raw.includes("://")) continue;
    found.add(toPosix(raw).replace(/^\.\//, ""));
  }
  return [...found];
}

function parseFrontmatter(head: string): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  let current: string | null = null;
  for (const raw of head.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && current) {
      (fields[current] ??= []).push(unquote(item[1]!));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    current = kv[1]!;
    const value = kv[2]!.trim();
    fields[current] = value ? [unquote(value)] : [];
    // Inline lists: `aliases: [a, b]`.
    if (value.startsWith("[") && value.endsWith("]")) {
      fields[current] = value
        .slice(1, -1)
        .split(",")
        .map((v) => unquote(v.trim()))
        .filter(Boolean);
    }
  }
  return fields;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseSource(raw: string): WikiSource | null {
  const [pathPart, hashPart] = raw.split("@").map((part) => part.trim());
  if (!pathPart) return null;
  return { path: toPosix(pathPart), hash: hashPart ?? "" };
}

function titleFromBody(body: string): string | undefined {
  const heading = /^#\s+(.+)$/m.exec(body);
  return heading?.[1]?.trim();
}
