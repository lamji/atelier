import type { RetrievedChunk } from "@atelier/protocol";
import type { Db } from "../../storage/db.js";

const FULL_CAP_CHARS = 2000;

/**
 * L5: the chunk's full stored text (previews are clipped at retrieval
 * time; the source of truth lives in the chunks table). Falls back to
 * the preview when the row has been re-indexed away.
 */
export function renderFull(
  chunk: RetrievedChunk,
  header: string,
  db: Db
): string {
  const row = db
    .prepare("SELECT text FROM chunks WHERE id = ?")
    .get(chunk.id) as { text: string } | undefined;
  const text = row?.text ?? chunk.preview;
  const body = text.length > FULL_CAP_CHARS
    ? `${text.slice(0, FULL_CAP_CHARS)}…`
    : text;
  return `${header}\n${body}`;
}
