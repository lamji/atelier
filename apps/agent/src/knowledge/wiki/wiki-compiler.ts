import type { Logger } from "pino";
import { clipToTokens } from "@atelier/shared";
import { parseWikiPage, pathsMentioned, type WikiPage } from "./wiki-page.js";
import { WIKI_SCHEMA, type WikiStore } from "./wiki-store.js";

export interface CompileInput {
  taskId: string;
  /** The user's request, verbatim. */
  request: string;
  /** The final assistant report for the task. */
  report: string;
  changedFiles: string[];
  /** Files the task read (from working memory), for the Files section. */
  readPaths: string[];
  planSteps: Array<{ title: string; files: string[]; status?: string }>;
  /** Working-tree diff of the change, already clipped by the caller. */
  diff: string;
  /** Pages the retrieval stage matched for this turn, best first. */
  candidates: WikiPage[];
}

export interface CompileResult {
  page: WikiPage;
  created: boolean;
  /** Section headings whose text changed, for the rail line. */
  changedSections: string[];
}

/**
 * Turns one finished task into a page update: the model gets the existing
 * page (or the schema), the request, the report, the diff, and the files
 * the task read, and returns the whole page with only the affected lines
 * changed. Atelier then recomputes the sources from the paths the page
 * cites, so freshness never depends on the model listing them right.
 *
 * One call, after the answer has streamed, off the user's critical path.
 * A failure here is logged and dropped — the wiki is compounding
 * knowledge, never a reason for a task to fail.
 */
export class WikiCompiler {
  constructor(
    private deps: {
      store: WikiStore;
      oneShot: (system: string, prompt: string) => Promise<string>;
      log: Logger;
    }
  ) {}

  async compile(input: CompileInput): Promise<CompileResult | null> {
    const existing = input.candidates[0] ?? null;
    const raw = await this.deps.oneShot(
      systemPrompt(),
      userPrompt(input, existing)
    );
    const markdown = extractMarkdown(raw);
    if (!markdown) {
      this.deps.log.warn({ taskId: input.taskId }, "wiki: model returned no page");
      return null;
    }
    const draft = parseWikiPage(existing?.slug ?? "draft", markdown);
    if (!draft.title || !/^##\s+Flow/m.test(draft.body)) {
      this.deps.log.warn(
        { taskId: input.taskId },
        "wiki: page missing a title or a Flow section — dropped"
      );
      return null;
    }
    // Keep the matched page's identity even if the model retitled it; a
    // rename would leave the old file behind as a near-duplicate.
    const slug = existing?.slug ?? this.deps.store.slugFor(draft.title);
    const previous = existing ?? this.deps.store.get(slug);
    const cited = pathsMentioned(draft.body);
    const page: WikiPage = {
      slug,
      title: draft.title,
      aliases: dedupe([...(previous?.aliases ?? []), ...draft.aliases]),
      status: "fresh",
      sources: this.deps.store.sourcesFor([...cited, ...input.changedFiles]),
      // Links merge like aliases: a rewrite that forgot the frontmatter
      // list must not drop the graph edges an earlier compile established.
      links: dedupe([...(previous?.links ?? []), ...draft.links]).filter(
        (link) => link !== slug
      ),
      verifiedBy: input.taskId,
      updatedAt: Date.now(),
      body: draft.body,
    };
    this.deps.store.save(page);
    return {
      page,
      created: previous === null,
      changedSections: changedSections(previous?.body ?? "", page.body),
    };
  }
}

function systemPrompt(): string {
  return (
    "You maintain Atelier's feature wiki: one markdown page per product " +
    "feature, compiled from real work and updated in place. Follow the " +
    "schema below exactly. Return ONLY the complete page — frontmatter " +
    "block first, then the body — with no commentary before or after.\n\n" +
    WIKI_SCHEMA
  );
}

function userPrompt(input: CompileInput, existing: WikiPage | null): string {
  const parts: string[] = [];
  if (existing) {
    parts.push(
      "EXISTING PAGE (update it in place — change only what this task " +
        "changed, keep every other line verbatim, add one History line, " +
        "and move any flow fact that is no longer true to Invalidated):"
    );
    parts.push(pageText(existing));
  } else {
    parts.push(
      "NO PAGE EXISTS for this feature yet. Write it from what the task " +
        "read and changed. Name the feature the way a user of the product " +
        "would (not after a file). Add aliases people would search by."
    );
  }
  parts.push("", `TASK REQUEST:\n${clipToTokens(input.request, 400)}`);
  if (input.planSteps.length > 0) {
    parts.push(
      "",
      "PLAN STEPS:",
      ...input.planSteps.map(
        (step) =>
          `- [${step.status ?? "?"}] ${step.title}` +
          (step.files.length > 0 ? ` (${step.files.join(", ")})` : "")
      )
    );
  }
  parts.push("", `FILES CHANGED:\n${input.changedFiles.map((f) => `- ${f}`).join("\n") || "- (none)"}`);
  if (input.readPaths.length > 0) {
    parts.push(
      "",
      `FILES READ BY THIS TASK (owners and neighbours; cite the relevant ones):\n` +
        input.readPaths.slice(0, 30).map((f) => `- ${f}`).join("\n")
    );
  }
  if (input.diff) parts.push("", "DIFF:", "```diff", input.diff, "```");
  parts.push("", `TASK REPORT:\n${clipToTokens(input.report, 900)}`);
  parts.push(
    "",
    "Write the page now. Every path:line you cite must come from the diff, " +
      "the files listed above, or the existing page."
  );
  return parts.join("\n");
}

function pageText(page: WikiPage): string {
  const head = [
    "---",
    `feature: ${page.title}`,
    `slug: ${page.slug}`,
    `status: ${page.status}`,
    page.aliases.length > 0 ? `aliases: [${page.aliases.join(", ")}]` : "",
    page.links.length > 0 ? `links: [${page.links.join(", ")}]` : "",
    "---",
  ]
    .filter(Boolean)
    .join("\n");
  return `${head}\n${page.body}`;
}

/** The model sometimes wraps the page in a fence; take what is inside. */
function extractMarkdown(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(trimmed);
  const text = fenced ? fenced[1]! : trimmed;
  const start = text.indexOf("---");
  return start >= 0 ? text.slice(start) : text;
}

function changedSections(before: string, after: string): string[] {
  const sections = (body: string): Map<string, string> => {
    const map = new Map<string, string>();
    let current = "(intro)";
    for (const line of body.split("\n")) {
      const heading = /^##\s+(.+)$/.exec(line);
      if (heading) {
        current = heading[1]!.trim();
        continue;
      }
      map.set(current, `${map.get(current) ?? ""}${line}\n`);
    }
    return map;
  };
  const a = sections(before);
  const b = sections(after);
  const out: string[] = [];
  for (const [name, text] of b) {
    if ((a.get(name) ?? "") !== text) out.push(name);
  }
  return out;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}
