import type { Db } from "../../storage/db.js";

export interface SymbolInfo {
  name: string;
  kind: string;
  signature: string;
  doc: string | null;
}

/** Symbol row backing a chunk, for signature/doc/AST-summary renders. */
export function symbolInfo(db: Db, symbolId: number): SymbolInfo | null {
  const row = db
    .prepare(
      "SELECT name, kind, signature, doc_comment FROM symbols WHERE id = ?"
    )
    .get(symbolId) as
    | { name: string; kind: string; signature: string; doc_comment: string | null }
    | undefined;
  if (!row) return null;
  return {
    name: row.name,
    kind: row.kind,
    signature: row.signature,
    doc: row.doc_comment,
  };
}
