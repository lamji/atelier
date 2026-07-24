import type { CodeSymbol, IndexStats, SymbolKind } from "@atelier/protocol";
import type { Db } from "../../storage/db.js";

interface SymbolDbRow {
  id: number;
  path: string;
  name: string;
  kind: string;
  signature: string | null;
  parent_symbol_id: number | null;
  start_row: number;
  start_col: number;
  end_row: number;
  end_col: number;
  doc_comment: string | null;
}

const SYMBOL_SELECT =
  "SELECT s.id, f.path, s.name, s.kind, s.signature, s.parent_symbol_id, " +
  "s.start_row, s.start_col, s.end_row, s.end_col, s.doc_comment " +
  "FROM symbols s JOIN files f ON f.id = s.file_id ";

/**
 * Answers engineering questions from the knowledge DB (symbols, edges,
 * features) before any RAG fallback.
 */
export class KnowledgeQuery {
  constructor(private db: Db) {}

  stats(): IndexStats {
    const count = (sql: string): number =>
      (this.db.prepare(sql).get() as { n: number }).n;
    const last = this.db
      .prepare("SELECT value FROM meta WHERE key='last_indexed_at'")
      .get() as { value: string } | undefined;
    return {
      files: count("SELECT COUNT(*) n FROM files"),
      symbols: count("SELECT COUNT(*) n FROM symbols"),
      edges: count("SELECT COUNT(*) n FROM call_edges"),
      chunks: count("SELECT COUNT(*) n FROM chunks"),
      embedded: count("SELECT COUNT(*) n FROM chunk_embeddings"),
      features: count("SELECT COUNT(*) n FROM features"),
      lessons: count("SELECT COUNT(*) n FROM lessons"),
      queued: count(
        "SELECT COUNT(*) n FROM index_jobs WHERE status IN ('queued','running')"
      ),
      lastIndexedAt: last ? Number(last.value) : null,
    };
  }

  symbol(id: number): CodeSymbol {
    const row = this.db.prepare(SYMBOL_SELECT + "WHERE s.id = ?").get(id) as
      | SymbolDbRow
      | undefined;
    if (!row) throw new Error(`Unknown symbol: ${id}`);
    return toCodeSymbol(row);
  }

  /** Scored fuzzy symbol search (name/path), for retrieval and tools. */
  search(query: string, limit = 20): CodeSymbol[] {
    const q = query.toLowerCase();
    if (!q) return [];
    const rows = this.db
      .prepare(
        SYMBOL_SELECT +
          "WHERE lower(s.name) LIKE ? OR lower(f.path) LIKE ? LIMIT 400"
      )
      .all(`%${q}%`, `%${q}%`) as SymbolDbRow[];
    const scored = rows.map((row) => {
      const name = row.name.toLowerCase();
      let score = 0;
      if (name === q) score = 100;
      else if (name.startsWith(q)) score = 70;
      else if (name.includes(q)) score = 50;
      else score = 10; // path match only
      if (row.kind === "class" || row.kind === "interface") score += 3;
      return { row, score };
    });
    scored.sort(
      (a, b) => b.score - a.score || a.row.name.length - b.row.name.length
    );
    return scored.slice(0, limit).map((s) => toCodeSymbol(s.row));
  }

  /** Exact-name lookup used by the retriever's graph arm. */
  byName(name: string, limit = 5): CodeSymbol[] {
    const rows = this.db
      .prepare(SYMBOL_SELECT + "WHERE s.name = ? COLLATE NOCASE LIMIT ?")
      .all(name, limit) as SymbolDbRow[];
    return rows.map(toCodeSymbol);
  }
}

function toCodeSymbol(row: SymbolDbRow): CodeSymbol {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    kind: (row.kind as SymbolKind) ?? "unknown",
    signature: row.signature ?? undefined,
    parentId: row.parent_symbol_id,
    startRow: row.start_row,
    startCol: row.start_col,
    endRow: row.end_row,
    endCol: row.end_col,
    docComment: row.doc_comment ?? undefined,
  };
}
