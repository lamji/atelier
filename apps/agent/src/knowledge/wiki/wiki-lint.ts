import type { WikiLintFinding, WikiPageInfo } from "@atelier/protocol";
import { WIKI_FEATURES_DIR, type WikiStore } from "./wiki-store.js";

/**
 * The wiki's health, computed on request — no model, no schedule. Lint is
 * the third operation of the wiki pattern (compile, query, lint): it is
 * what keeps a compiled knowledge base from quietly rotting. Every finding
 * is something a later compile can fix, and the panel shows them so a
 * person can too.
 */
export function inspectWiki(store: WikiStore): {
  pages: WikiPageInfo[];
  lint: WikiLintFinding[];
} {
  const all = store.list();
  const slugs = new Set(all.map((page) => page.slug));
  const pages: WikiPageInfo[] = [];
  const lint: WikiLintFinding[] = [];
  const owners = new Map<string, string[]>();

  for (const page of all) {
    const moved = store.moved(page);
    pages.push({
      slug: page.slug,
      title: page.title,
      status: moved.length > 0 ? "stale" : page.status,
      aliases: page.aliases,
      links: page.links,
      sources: page.sources.length,
      moved,
      updatedAt: page.updatedAt,
      ...(page.verifiedBy ? { verifiedBy: page.verifiedBy } : {}),
      path: `${WIKI_FEATURES_DIR}/${page.slug}.md`,
    });
    for (const link of page.links) {
      if (!slugs.has(link)) {
        lint.push({
          kind: "broken-link",
          slug: page.slug,
          detail: `links to [[${link}]], which has no page`,
        });
      }
    }
    for (const entry of moved) {
      if (entry.endsWith("(missing)")) {
        lint.push({
          kind: "missing-source",
          slug: page.slug,
          detail: `cites ${entry.replace(" (missing)", "")}, which no longer exists`,
        });
      }
    }
    if (moved.some((entry) => !entry.endsWith("(missing)"))) {
      lint.push({
        kind: "stale",
        slug: page.slug,
        detail: `${moved.filter((e) => !e.endsWith("(missing)")).length} source(s) changed since verification`,
      });
    }
    if (!/^##\s+Flow/m.test(page.body)) {
      lint.push({ kind: "no-flow", slug: page.slug, detail: "page has no Flow section" });
    }
    for (const source of page.sources) {
      const list = owners.get(source.path) ?? [];
      list.push(page.slug);
      owners.set(source.path, list);
    }
  }
  // Two pages sourcing the same file is normal for shared utilities and a
  // smell for entry points; report only when a file is claimed by three or
  // more, which is where the duplicate-page pattern shows.
  for (const [file, claimants] of owners) {
    if (claimants.length >= 3) {
      lint.push({
        kind: "shared-owner",
        slug: claimants[0]!,
        detail: `${file} is a source of ${claimants.length} pages: ${claimants.join(", ")}`,
      });
    }
  }
  pages.sort((a, b) => b.updatedAt - a.updatedAt);
  return { pages, lint };
}
