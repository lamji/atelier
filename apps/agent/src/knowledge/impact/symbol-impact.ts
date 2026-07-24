import type { EditImpact, EditUseSite } from "@atelier/protocol";
import type { Db } from "../../storage/db.js";

interface SymbolRow {
  id: number;
  name: string;
  kind: string;
  file_id: number;
  start_row: number;
  end_row: number;
}

/**
 * Word-boundary search for an identifier across the workspace. Returns the
 * files (and a sample row) that literally mention the name. Injected so the
 * analyzer can catch dynamic/string-keyed uses the graph never resolved.
 */
export type IdentifierSearch = (
  identifier: string
) => Promise<Array<{ path: string; row: number }>>;

const MAX_USES = 60;
/** Names shorter than this are too noisy for a useful textual search. */
const MIN_TEXT_NAME = 3;
const MAX_TEXT_FILES = 20;

/**
 * Answers the questions you ask before changing a line of code:
 *  - which symbol does this edit sit inside?
 *  - is it exported (does the change cross the module boundary)?
 *  - who USES it — calls, references, imports — in this file and others?
 *  - so: update the callers too, or is this isolated?
 *
 * Precise where the file-level radius is coarse: it keys on the exact
 * symbol at the edit site, not "anything that imports this file."
 */
export class SymbolImpactAnalyzer {
  constructor(
    private db: Db,
    /** Optional textual fallback for uses the graph can't resolve. */
    private searchIdentifier?: IdentifierSearch
  ) {}

  /** Impact of editing `relPath` at 1-based `line`, or a named symbol. */
  async analyze(
    relPath: string,
    line?: number,
    symbolName?: string
  ): Promise<EditImpact | null> {
    const file = this.db
      .prepare("SELECT id, path FROM files WHERE path = ? COLLATE NOCASE")
      .get(relPath) as { id: number; path: string } | undefined;
    if (!file) return null;

    const symbol = symbolName
      ? this.symbolByName(file.id, symbolName)
      : line !== undefined
        ? this.enclosingSymbol(file.id, line)
        : null;
    if (!symbol) return null;

    const exported = this.isExported(symbol.id, symbol.name);
    const resolved = this.usesOf(symbol.id, symbol.name, file.id).slice(
      0,
      MAX_USES
    );
    const resolvedFiles = new Set(resolved.map((u) => u.path));
    resolvedFiles.add(file.path);

    // Textual arm: files that mention the name but have no resolved edge —
    // dynamic dispatch, string keys, DI. Lower confidence, flagged to verify.
    const textual = await this.textualUses(symbol.name, resolvedFiles);
    const uses = [...resolved, ...textual].slice(0, MAX_USES);

    const externalFiles = [
      ...new Set(resolved.filter((u) => !u.sameFile).map((u) => u.path)),
    ];
    const textualFiles = textual.map((u) => u.path);
    const hasExternal = externalFiles.length > 0 || textualFiles.length > 0;
    const reach: EditImpact["reach"] = hasExternal
      ? "shared"
      : resolved.length > 0
        ? "local"
        : "isolated";

    return {
      path: file.path,
      symbol: symbol.name,
      kind: symbol.kind,
      exported,
      uses,
      externalFiles,
      textualFiles,
      reach,
      summary: summarize(
        symbol.name,
        exported,
        resolved,
        externalFiles,
        textualFiles,
        reach
      ),
    };
  }

  /** Name matches in files with no resolved edge to the symbol. */
  private async textualUses(
    name: string,
    exclude: Set<string>
  ): Promise<EditUseSite[]> {
    if (!this.searchIdentifier || name.length < MIN_TEXT_NAME) return [];
    let hits: Array<{ path: string; row: number }>;
    try {
      hits = await this.searchIdentifier(name);
    } catch {
      return [];
    }
    const firstPerFile = new Map<string, number>();
    for (const hit of hits) {
      if (exclude.has(hit.path)) continue;
      if (!firstPerFile.has(hit.path)) firstPerFile.set(hit.path, hit.row);
      if (firstPerFile.size >= MAX_TEXT_FILES) break;
    }
    return [...firstPerFile.entries()].map(([path, row]) => ({
      path,
      row,
      via: "text" as const,
      sameFile: false,
    }));
  }

  /** The innermost symbol whose row span contains the line. */
  private enclosingSymbol(fileId: number, line: number): SymbolRow | null {
    const row0 = line - 1;
    return (
      (this.db
        .prepare(
          "SELECT id, name, kind, file_id, start_row, end_row FROM symbols " +
            "WHERE file_id = ? AND start_row <= ? AND end_row >= ? " +
            "ORDER BY (end_row - start_row) ASC LIMIT 1"
        )
        .get(fileId, row0, row0) as SymbolRow | undefined) ?? null
    );
  }

  private symbolByName(fileId: number, name: string): SymbolRow | null {
    return (
      (this.db
        .prepare(
          "SELECT id, name, kind, file_id, start_row, end_row FROM symbols " +
            "WHERE file_id = ? AND name = ? AND parent_symbol_id IS NULL LIMIT 1"
        )
        .get(fileId, name) as SymbolRow | undefined) ?? null
    );
  }

  private isExported(symbolId: number, name: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM exports WHERE symbol_id = ? OR exported_name = ? LIMIT 1"
      )
      .get(symbolId, name);
    return Boolean(row);
  }

  /** Call edges + references + name imports that touch the symbol. */
  private usesOf(
    symbolId: number,
    name: string,
    homeFileId: number
  ): EditUseSite[] {
    const uses: EditUseSite[] = [];

    const callers = this.db
      .prepare(
        "SELECT cs.name AS symbol, cf.path AS path, cs.file_id AS fileId, " +
          "ce.site_row AS row FROM call_edges ce " +
          "JOIN symbols cs ON cs.id = ce.caller_symbol_id " +
          "JOIN files cf ON cf.id = cs.file_id " +
          "WHERE ce.callee_symbol_id = ? LIMIT 60"
      )
      .all(symbolId) as Array<{
      symbol: string;
      path: string;
      fileId: number;
      row: number;
    }>;
    for (const c of callers) {
      uses.push({
        path: c.path,
        symbol: c.symbol,
        row: c.row,
        via: "call",
        sameFile: c.fileId === homeFileId,
      });
    }

    const refs = this.db
      .prepare(
        "SELECT rf.path AS path, sr.file_id AS fileId, sr.row AS row " +
          "FROM symbol_refs sr JOIN files rf ON rf.id = sr.file_id " +
          "WHERE sr.symbol_id = ? LIMIT 60"
      )
      .all(symbolId) as Array<{ path: string; fileId: number; row: number }>;
    for (const r of refs) {
      uses.push({
        path: r.path,
        row: r.row,
        via: "ref",
        sameFile: r.fileId === homeFileId,
      });
    }

    // Files that import this name (structural users with no resolved edge).
    const importers = this.db
      .prepare(
        "SELECT f.path AS path, i.file_id AS fileId, i.imported_names AS names " +
          "FROM imports i JOIN files f ON f.id = i.file_id " +
          "WHERE i.resolved_file_id = ? LIMIT 60"
      )
      .all(homeFileId) as Array<{
      path: string;
      fileId: number;
      names: string | null;
    }>;
    const seen = new Set(uses.map((u) => `${u.path}:${u.via}`));
    for (const imp of importers) {
      let names: string[] = [];
      try {
        names = imp.names ? (JSON.parse(imp.names) as string[]) : [];
      } catch {
        names = [];
      }
      if (names.length > 0 && !names.includes(name)) continue;
      const key = `${imp.path}:import`;
      if (seen.has(key)) continue;
      seen.add(key);
      uses.push({
        path: imp.path,
        via: "import",
        sameFile: imp.fileId === homeFileId,
      });
    }

    // Same-file uses first, then by path.
    return uses.sort((a, b) =>
      a.sameFile === b.sameFile
        ? a.path.localeCompare(b.path)
        : a.sameFile
          ? -1
          : 1
    );
  }
}

function summarize(
  name: string,
  exported: boolean,
  resolved: EditUseSite[],
  externalFiles: string[],
  textualFiles: string[],
  reach: EditImpact["reach"]
): string {
  const textNote =
    textualFiles.length > 0
      ? ` Plus ${textualFiles.length} unresolved textual mention(s) ` +
        "(dynamic/string use — verify)."
      : "";

  if (reach === "isolated") {
    return (
      `${name} is ${exported ? "exported but " : ""}unused elsewhere — ` +
      "safe to change in isolation." + textNote
    );
  }
  if (reach === "local") {
    return (
      `${name} is used ${resolved.length}× within this file only — update ` +
      "those uses if you change its behavior." + textNote
    );
  }
  if (externalFiles.length === 0) {
    // Shared purely via textual matches — no resolved cross-file edge.
    return (
      `${name} has no resolved cross-file caller, but ${textualFiles.length} ` +
      "file(s) mention it (likely dynamic/string use) — verify each before " +
      "assuming it is safe to change."
    );
  }
  return (
    `${name} is used by ${resolved.length} resolved site(s) across ` +
    `${externalFiles.length} other file(s)${exported ? " (exported)" : ""} — ` +
    "a signature/behavior change must update them, or keep the contract " +
    "stable to isolate." + textNote
  );
}
