import type { SymbolKind } from "@atelier/protocol";

/** One call site inside a symbol body. */
export interface CallSite {
  /** Callee identifier (last member segment for a.b.c()). */
  name: string;
  /** 0-based row of the call expression. */
  row: number;
}

export interface ExtractedSymbol {
  name: string;
  /** "Parent.name" for members, otherwise the name itself. */
  qualifiedName: string;
  kind: SymbolKind;
  signature: string;
  doc?: string;
  /** Qualified name of the enclosing class/interface, if any. */
  parentQualifiedName?: string;
  exported: boolean;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  calls: CallSite[];
}

export interface ExtractedImport {
  specifier: string;
  names: string[];
  typeOnly: boolean;
}

export interface ExtractedExport {
  exportedName: string;
  /** Local symbol name the export points at (differs on `as` renames). */
  localName?: string;
  isDefault: boolean;
  reExportFrom?: string;
}

export interface ExtractedFile {
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  exports: ExtractedExport[];
}
