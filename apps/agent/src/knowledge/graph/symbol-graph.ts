import type { KnowledgeGraph } from "@atelier/protocol";
import { NotImplementedError } from "../../not-implemented.js";
import type { Db } from "../../storage/db.js";

/** Phase 5: import/call/symbol graph queries over the SQLite store. */
export class SymbolGraph {
  constructor(private db: Db) {}

  graphFor(
    _scope: "file" | "symbol" | "feature" | "workspace",
    _target?: string,
    _depth?: number
  ): KnowledgeGraph {
    throw new NotImplementedError("knowledge.graph");
  }

  /** Files/symbols that depend on the given files (impact analysis). */
  dependentsOf(_paths: string[]): { files: string[]; symbols: string[] } {
    return { files: [], symbols: [] };
  }
}
