/**
 * read_file returns raw text instead of JSON: escaping a whole source
 * file (quotes, backslashes, newlines) inflates it 15-30% for nothing.
 * The mtime field is dropped — the model never needs it.
 */
export function shapeReadFile(result: unknown): string | null {
  const many = result as {
    files?: Array<{
      path?: string;
      content?: string;
      totalLines?: number;
    }>;
  };
  if (Array.isArray(many?.files)) {
    return many.files
      .filter(
        (file) =>
          typeof file.path === "string" && typeof file.content === "string"
      )
      .map((file) => {
        const header =
          file.totalLines !== undefined
            ? `### ${file.path} [slice, ${file.totalLines} lines total]`
            : `### ${file.path}`;
        return `${header}\n${file.content}`;
      })
      .join("\n\n");
  }

  const r = result as { content?: string; totalLines?: number };
  if (typeof r?.content !== "string") return null;
  const header =
    r.totalLines !== undefined
      ? `[slice — file has ${r.totalLines} lines total]\n`
      : "";
  return header + r.content;
}
