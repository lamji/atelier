import type { ParsedFile } from "../parsing/parser-pool.js";

/** Rough token budget per chunk (~4 chars per token). */
const MAX_CHUNK_CHARS = 1600;

export interface BuiltChunk {
  /** Qualified name of the symbol this chunk covers; null = file overview. */
  symbolQualifiedName: string | null;
  kind: "code" | "doc";
  text: string;
  tokenCount: number;
  startRow?: number;
  endRow?: number;
}

/**
 * One chunk per top-level symbol (signature + doc + body, capped ~400
 * tokens) plus a file-overview chunk carrying imports and the symbol
 * roster — that overview is what makes "what handles X?" queries land on
 * the right file even when no single symbol matches.
 */
export function buildChunks(parsed: ParsedFile, source: string): BuiltChunk[] {
  const lines = source.split(/\r?\n/);
  const chunks: BuiltChunk[] = [];

  const importList = parsed.imports.map((i) => i.specifier).join(", ");
  const roster = parsed.symbols
    .filter((s) => !s.parentQualifiedName)
    .map((s) => `${s.name} (${s.kind})`)
    .join(", ");
  const overview = clip(
    `${parsed.path}\nimports: ${importList || "none"}\nsymbols: ${roster || "none"}`
  );
  chunks.push({
    symbolQualifiedName: null,
    kind: "doc",
    text: overview,
    tokenCount: approxTokens(overview),
  });

  for (const sym of parsed.symbols) {
    if (sym.parentQualifiedName) continue; // members ride in the parent chunk
    const body = lines.slice(sym.startRow, sym.endRow + 1).join("\n");
    const header = `${parsed.path} :: ${sym.qualifiedName} (${sym.kind})`;
    const doc = sym.doc ? `\n${sym.doc}` : "";
    const text = clip(`${header}${doc}\n${body}`);
    chunks.push({
      symbolQualifiedName: sym.qualifiedName,
      kind: "code",
      text,
      tokenCount: approxTokens(text),
      startRow: sym.startRow,
      endRow: sym.endRow,
    });
  }
  return chunks;
}

function clip(text: string): string {
  return text.length > MAX_CHUNK_CHARS
    ? text.slice(0, MAX_CHUNK_CHARS - 3) + "..."
    : text;
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
