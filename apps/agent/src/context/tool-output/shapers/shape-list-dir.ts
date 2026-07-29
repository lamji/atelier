/**
 * list_dir returns size and mtime per entry for the UI; the model needs
 * neither. One line per directory, one for the files, and the recovery
 * note when the requested path did not exist — the note is the whole
 * point of the call in that case, so it leads.
 */
export function shapeListDir(result: unknown): string | null {
  const r = result as {
    path?: string;
    requested?: string;
    note?: string;
    entries?: Array<{ name?: string; type?: string }>;
  };
  if (!Array.isArray(r?.entries)) return null;

  const dirs = r.entries
    .filter((e) => e.type === "dir" && typeof e.name === "string")
    .map((e) => `${e.name}/`);
  const filenames = r.entries
    .filter((e) => e.type === "file" && typeof e.name === "string")
    .map((e) => e.name as string);

  const lines: string[] = [];
  if (r.note) lines.push(`NOTE: ${r.note}`);
  lines.push(`${r.path || "<workspace root>"} — ${r.entries.length} entries`);
  if (dirs.length > 0) lines.push(`dirs: ${dirs.join(", ")}`);
  if (filenames.length > 0) lines.push(`files: ${filenames.join(", ")}`);
  if (r.entries.length === 0) lines.push("(empty)");
  return lines.join("\n");
}
