import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { toPosix } from "@atelier/shared";
import {
  parseWikiPage,
  serializeWikiPage,
  slugify,
  type WikiPage,
  type WikiSource,
} from "./wiki-page.js";

/** Where the wiki lives, workspace-relative. Obsidian can open this folder. */
export const WIKI_DIR = ".atelier/wiki";
export const WIKI_FEATURES_DIR = `${WIKI_DIR}/features`;
export const WIKI_SCHEMA_FILE = `${WIKI_DIR}/SCHEMA.md`;

/**
 * The feature wiki on disk: one markdown page per feature under
 * `.atelier/wiki/features/`, plus the schema page that says how pages are
 * written.
 *
 * Filesystem-first on purpose. A few dozen small files parse in
 * milliseconds and are cached by mtime, the folder opens in Obsidian as a
 * vault, and a person can fix a page with any editor — none of which a
 * table gives. Freshness is computed at read time by re-hashing a page's
 * sources, so it is always right and needs no event plumbing.
 */
export class WikiStore {
  private cache = new Map<string, { mtimeMs: number; page: WikiPage }>();

  constructor(private workspaceRoot: string) {}

  /** Every page, parsed. */
  list(): WikiPage[] {
    const dir = this.abs(WIKI_FEATURES_DIR);
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith(".md"));
    } catch {
      return [];
    }
    const pages: WikiPage[] = [];
    for (const name of names) {
      const page = this.get(name.slice(0, -3));
      if (page) pages.push(page);
    }
    return pages;
  }

  get(slug: string): WikiPage | null {
    const file = this.pageFile(slug);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      this.cache.delete(slug);
      return null;
    }
    const cached = this.cache.get(slug);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.page;
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
    const page = parseWikiPage(slug, content);
    this.cache.set(slug, { mtimeMs: stat.mtimeMs, page });
    return page;
  }

  /** Writes the page and the schema beside it on first use. */
  save(page: WikiPage): void {
    fs.mkdirSync(this.abs(WIKI_FEATURES_DIR), { recursive: true });
    this.ensureSchema();
    fs.writeFileSync(this.pageFile(page.slug), serializeWikiPage(page), "utf8");
    this.cache.delete(page.slug);
  }

  /**
   * Which of a page's sources changed since it was written. Missing files
   * count as moved — a page citing a deleted file is stale in the most
   * important way.
   */
  moved(page: WikiPage): string[] {
    const out: string[] = [];
    for (const source of page.sources) {
      const hash = this.hashOf(source.path);
      if (hash === null) out.push(`${source.path} (missing)`);
      else if (source.hash && hash !== source.hash) out.push(source.path);
    }
    return out;
  }

  /** Current hashes for the given paths, skipping what does not exist. */
  sourcesFor(paths: string[]): WikiSource[] {
    const out: WikiSource[] = [];
    for (const raw of [...new Set(paths.map((p) => toPosix(p)))]) {
      const hash = this.hashOf(raw);
      if (hash !== null) out.push({ path: raw, hash });
    }
    return out;
  }

  /**
   * Pages that plausibly describe what a turn is about. Two signals: the
   * words of the prompt against title/aliases/slug (a name hit outweighs
   * a body hit), and the files this turn already points at against the
   * page's sources. Deterministic and cheap; the retrieval stage runs it
   * on every turn.
   */
  match(input: {
    terms: string[];
    /** Files the turn merely touches (anchors, retrieval hits): weak. */
    files: string[];
    /** Files the user named or the intent targets: strong on their own. */
    namedFiles?: string[];
    limit?: number;
  }): Array<{ page: WikiPage; score: number }> {
    const files = new Set(input.files.map((f) => toPosix(f)));
    const named = new Set((input.namedFiles ?? []).map((f) => toPosix(f)));
    const terms = input.terms.map((t) => t.toLowerCase()).filter(Boolean);
    const scored: Array<{ page: WikiPage; score: number }> = [];
    for (const page of this.list()) {
      let score = 0;
      const names = [page.title, page.slug, ...page.aliases]
        .join(" ")
        .toLowerCase();
      for (const term of terms) {
        if (names.includes(term)) score += 3;
      }
      // A multi-word alias/title fully present in the prompt is a stronger
      // signal than the sum of its words.
      const prompt = terms.join(" ");
      for (const alias of [page.title, ...page.aliases]) {
        const lower = alias.toLowerCase();
        if (lower.split(/\s+/).length > 1 && prompt.includes(lower)) score += 4;
      }
      for (const source of page.sources) {
        if (named.has(source.path)) score += 3;
        else if (files.has(source.path)) score += 2;
      }
      if (score >= 3) scored.push({ page, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, input.limit ?? 2);
  }

  /** Pages whose sources include any of these files. */
  pagesForFiles(paths: string[]): WikiPage[] {
    const files = new Set(paths.map((p) => toPosix(p)));
    return this.list().filter((page) =>
      page.sources.some((source) => files.has(source.path))
    );
  }

  hashOf(rel: string): string | null {
    const clean = toPosix(rel).replace(/^\.\//, "");
    if (!clean || clean.includes("..")) return null;
    try {
      const buffer = fs.readFileSync(this.abs(clean));
      return createHash("sha1").update(buffer).digest("hex").slice(0, 12);
    } catch {
      return null;
    }
  }

  slugFor(title: string): string {
    return slugify(title) || "untitled";
  }

  private ensureSchema(): void {
    const file = this.abs(WIKI_SCHEMA_FILE);
    if (fs.existsSync(file)) return;
    fs.writeFileSync(file, WIKI_SCHEMA, "utf8");
  }

  private pageFile(slug: string): string {
    return this.abs(`${WIKI_FEATURES_DIR}/${slug}.md`);
  }

  private abs(rel: string): string {
    return path.join(this.workspaceRoot, ...rel.split("/"));
  }
}

/**
 * The conventions every page follows. Written beside the pages so a
 * person editing the vault sees the same contract the model is given.
 */
export const WIKI_SCHEMA = `# Atelier feature wiki — schema

One page per product feature, under \`features/<slug>.md\`. Pages are
COMPILED knowledge: written once from a task that touched the feature,
then UPDATED IN PLACE by later tasks. Never a log — a page describes the
feature as it is now; history lives in its own section.

## Frontmatter
- \`feature\`: human name. \`slug\`: file name. \`aliases\`: other names
  people use for it (route names, component names, nicknames).
- \`status\`: fresh | stale | draft. Atelier sets it from the sources.
- \`sources\`: "path @ hash" for every file the page's claims rest on.
  Atelier recomputes these on save; a page is stale when one moved.
- \`links\`: slugs of related pages. \`[[wikilinks]]\` in the body count too.

## Sections (keep these headings, in this order)
1. \`## Purpose\` — two or three sentences: what the feature does for the user.
2. \`## Entry points\` — where it starts: route, component, command, hook.
   One bullet each, with \`path:line\`.
3. \`## Flow\` — numbered steps from entry to effect, each with \`path:line\`
   and the function or handler involved. This is the section a later task
   reads INSTEAD of re-reading the files, so it must be exact.
4. \`## Files\` — every owner file and its role, one line each.
5. \`## Contracts\` — RPC methods, state shape, env vars, external calls.
6. \`## Gotchas\` — things that bit a task before; the reason, not the story.
7. \`## History\` — one line per task that changed the feature, newest
   first: date, what changed, files. Keep the last ten.
8. \`## Invalidated\` — flow facts that used to be true and no longer are,
   each with when it stopped being true. Never delete a fact silently.

## Rules for updating
- Change only what the task changed; keep every other line verbatim.
- Cite real paths that exist in the workspace; no invented files.
- Prefer editing an existing page over creating a near-duplicate.
- A page is a lead, not proof: a reader still verifies stale-marked steps.
`;
