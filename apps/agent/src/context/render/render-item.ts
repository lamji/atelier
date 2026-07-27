import type { RetrievedChunk } from "@atelier/protocol";
import type { Db } from "../../storage/db.js";
import type { RenderLevel } from "../types.js";
import { symbolInfo } from "./symbol-info.js";
import { renderAstSummary } from "./render-ast-summary.js";
import { renderFull } from "./render-full.js";

const PREVIEW_CAP_CHARS = 600;

/**
 * Renders one retrieved chunk at a ladder level:
 *   L1 signature line · L2 +doc · L3 AST summary (callers/callees)
 *   L4 clipped preview · L5 full chunk text from the DB.
 * The packer calls this with descending levels until the item fits.
 */
export function renderItem(
  chunk: RetrievedChunk,
  level: RenderLevel,
  db: Db
): string {
  const head = header(chunk, db);
  if (level === 1) return head;
  const sym = chunk.symbolId ? symbolInfo(db, chunk.symbolId) : null;
  if (level === 2) {
    return sym?.doc ? `${head}\n  ${firstLines(sym.doc, 3)}` : head;
  }
  if (level === 3) return renderAstSummary(chunk, head, sym, db);
  if (level === 4) return `${head}\n${clip(chunk.preview, PREVIEW_CAP_CHARS)}`;
  return renderFull(chunk, head, db);
}

function header(chunk: RetrievedChunk, db: Db): string {
  const rows =
    chunk.startRow !== undefined
      ? `:${chunk.startRow}-${chunk.endRow ?? "?"}`
      : "";
  const sym = chunk.symbolId ? symbolInfo(db, chunk.symbolId) : null;
  const sig = sym ? ` ${sym.kind} ${sym.signature}` : "";
  return `- [${chunk.kind}] ${chunk.path}${rows}${sig}`;
}

function firstLines(text: string, n: number): string {
  return text.split(/\r?\n/).slice(0, n).join(" ").trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
