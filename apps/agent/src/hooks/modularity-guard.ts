import { ParserPool } from "../knowledge/parsing/parser-pool.js";
import type { ExtractedSymbol } from "../knowledge/parsing/extracted.js";

export const MODULARITY_HOOK_ID = "builtin-modularity";
export const MODULARITY_HOOK_NAME = "Modularity: one function per file";

/** Top-level symbol kinds that count against the one-per-file rule. */
const COUNTED_KINDS = new Set(["function", "component", "hook", "class"]);

export type GuardVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Structural write guard: parses candidate file content with the same
 * tree-sitter extractor that feeds the knowledge graph and blocks writes
 * that would create or GROW a multi-function file. One file = one
 * function/component/class keeps the graph precise and retrieval sharp.
 *
 * Legacy files that already violate the rule stay editable (fixes must
 * not be blocked) — but adding yet another top-level function to them is
 * refused, so the codebase converges toward modularity instead of away.
 */
export class ModularityGuard {
  private pool = new ParserPool();

  async check(
    relPath: string,
    nextContent: string,
    prevContent = ""
  ): Promise<GuardVerdict> {
    if (this.pool.langFor(relPath) === null) return { ok: true };

    const next = await this.countedSymbols(relPath, nextContent);
    if (next === null || next.length < 2) return { ok: true };

    // Existing offenders: allow edits that do not increase the count.
    const prev = prevContent
      ? await this.countedSymbols(relPath, prevContent)
      : [];
    const prevCount = prev?.length ?? 0;
    if (next.length <= prevCount) return { ok: true };

    const roster = next
      .map((s) => `${s.name} (${s.kind})`)
      .join(", ");
    return {
      ok: false,
      reason:
        `${relPath} would contain ${next.length} top-level ` +
        `functions/components/classes: ${roster}. Atelier modularity rule: ` +
        "ONE file = ONE function/component/class. Split each into its own " +
        "file in a folder (e.g. helpers/formatDate.ts, helpers/parseDate.ts) " +
        "and re-export from an index.ts barrel if a grouped import is " +
        "wanted. Types, interfaces, and constants may share a file.",
    };
  }

  private async countedSymbols(
    relPath: string,
    content: string
  ): Promise<ExtractedSymbol[] | null> {
    try {
      const parsed = await this.pool.parseFile(relPath, content);
      if (!parsed) return null;
      return parsed.symbols.filter(
        (s) => !s.parentQualifiedName && COUNTED_KINDS.has(s.kind)
      );
    } catch {
      // Never let a parser hiccup block a write.
      return null;
    }
  }
}
