/**
 * Extension -> tree-sitter grammar map. Grammar names follow the
 * tree-sitter-wasms package naming: wasm file = tree-sitter-<grammar>.wasm.
 * Phase 5 ships TS/TSX/JS; more grammars land in Phase 8.
 */
export interface LangSpec {
  /** Grammar (wasm) name. */
  grammar: string;
  /** Language name stored in the files table. */
  name: string;
}

const EXT_TO_LANG: Record<string, LangSpec> = {
  ts: { grammar: "typescript", name: "typescript" },
  mts: { grammar: "typescript", name: "typescript" },
  cts: { grammar: "typescript", name: "typescript" },
  tsx: { grammar: "tsx", name: "tsx" },
  js: { grammar: "javascript", name: "javascript" },
  mjs: { grammar: "javascript", name: "javascript" },
  cjs: { grammar: "javascript", name: "javascript" },
  jsx: { grammar: "javascript", name: "javascript" },
};

export function languageForFile(relPath: string): LangSpec | null {
  const dot = relPath.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = relPath.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

export function isIndexable(relPath: string): boolean {
  return languageForFile(relPath) !== null;
}
