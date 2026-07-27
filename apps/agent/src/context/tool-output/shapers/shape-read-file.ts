/**
 * read_file returns raw text instead of JSON: escaping a whole source
 * file (quotes, backslashes, newlines) inflates it 15-30% for nothing.
 * The mtime field is dropped — the model never needs it.
 */
export function shapeReadFile(result: unknown): string | null {
  const r = result as { content?: string; totalLines?: number };
  if (typeof r?.content !== "string") return null;
  const header =
    r.totalLines !== undefined
      ? `[slice — file has ${r.totalLines} lines total]\n`
      : "";
  return header + r.content;
}
