import type { RetrievedChunk } from "@atelier/protocol";
import type { Db } from "../../storage/db.js";
import type { SymbolInfo } from "./symbol-info.js";

const MAX_NEIGHBORS = 5;

/**
 * L3: what the symbol is and how it connects — signature, doc, top
 * callers and callees from the graph. Says what a function does and who
 * depends on it in ~120 tokens instead of its whole body.
 */
export function renderAstSummary(
  chunk: RetrievedChunk,
  header: string,
  sym: SymbolInfo | null,
  db: Db
): string {
  const lines = [header];
  if (sym?.doc) lines.push(`  ${sym.doc.split(/\r?\n/).slice(0, 3).join(" ")}`);
  if (chunk.symbolId) {
    const callees = neighborNames(
      db,
      "SELECT DISTINCT callee_name AS name FROM call_edges " +
        "WHERE caller_symbol_id = ? LIMIT ?",
      chunk.symbolId
    );
    const callers = neighborNames(
      db,
      "SELECT DISTINCT s.name AS name FROM call_edges e " +
        "JOIN symbols s ON s.id = e.caller_symbol_id " +
        "WHERE e.callee_symbol_id = ? LIMIT ?",
      chunk.symbolId
    );
    if (callees.length > 0) lines.push(`  calls: ${callees.join(", ")}`);
    if (callers.length > 0) lines.push(`  called by: ${callers.join(", ")}`);
  }
  return lines.join("\n");
}

function neighborNames(db: Db, sql: string, symbolId: number): string[] {
  const rows = db.prepare(sql).all(symbolId, MAX_NEIGHBORS) as Array<{
    name: string;
  }>;
  return rows.map((r) => r.name);
}
