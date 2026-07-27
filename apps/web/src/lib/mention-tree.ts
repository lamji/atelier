/**
 * Path helpers for the composer's "@" mention browser.
 *
 * Browsing reads one folder at a time over `fs.list` (a real readdir, like
 * the file explorer), so the listing is always complete — every folder at
 * every depth, empty ones included. The flat `fs.files` list is used only
 * for the search fallback, where a cap costs nothing.
 */

export interface MentionEntry {
  /** Workspace-relative path. Directories carry no trailing slash. */
  path: string;
  name: string;
  isDir: boolean;
}

/** Folders before files, then case-insensitive by name. */
function compareEntries(a: MentionEntry, b: MentionEntry): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/** Explorer order for a freshly listed folder. */
export function sortMentionEntries(entries: MentionEntry[]): MentionEntry[] {
  return [...entries].sort(compareEntries);
}

/**
 * Splits the typed "@" token into the folder being browsed and the text
 * filtering that folder — "src/views/Chat" → dir "src/views", filter "Chat".
 */
export function splitMentionPath(token: string): {
  dir: string;
  filter: string;
} {
  const slash = token.lastIndexOf("/");
  if (slash < 0) return { dir: "", filter: token };
  return { dir: token.slice(0, slash), filter: token.slice(slash + 1) };
}

/** The folder holding `dir` ("" once you're back at the workspace root). */
export function parentDir(dir: string): string {
  const slash = dir.lastIndexOf("/");
  return slash < 0 ? "" : dir.slice(0, slash);
}

/** Name-prefix matches first, then name substrings, then path substrings. */
export function rankMentionEntries(
  entries: MentionEntry[],
  query: string
): MentionEntry[] {
  const q = query.toLowerCase();
  const scored: Array<{ entry: MentionEntry; score: number }> = [];
  for (const entry of entries) {
    const score = scorePath(entry.name.toLowerCase(), entry.path, q);
    if (score >= 0) scored.push({ entry, score });
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.entry.path.length - b.entry.path.length ||
      compareEntries(a.entry, b.entry)
  );
  return scored.map((s) => s.entry);
}

function scorePath(name: string, path: string, q: string): number {
  if (name.startsWith(q)) return 0;
  if (name.includes(q)) return 1;
  if (path.toLowerCase().includes(q)) return 2;
  return -1;
}

/**
 * Fallback when nothing in the open folder matches: a fuzzy search over the
 * flat workspace file list, limited to what lives under that folder — so
 * "@ChatPanel" still finds a deeply nested file without browsing to it.
 */
export function searchMentionFiles(
  files: string[],
  dir: string,
  query: string,
  limit: number
): MentionEntry[] {
  const prefix = dir === "" ? "" : `${dir}/`;
  const q = query.toLowerCase();
  const scored: Array<{ entry: MentionEntry; score: number }> = [];
  for (const path of files) {
    if (prefix !== "" && !path.startsWith(prefix)) continue;
    const name = path.slice(path.lastIndexOf("/") + 1);
    const score = scorePath(name.toLowerCase(), path, q);
    if (score >= 0) scored.push({ entry: { path, name, isDir: false }, score });
  }
  scored.sort(
    (a, b) => a.score - b.score || a.entry.path.length - b.entry.path.length
  );
  return scored.slice(0, limit).map((s) => s.entry);
}
