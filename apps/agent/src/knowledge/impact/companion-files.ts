import fs from "node:fs";
import path from "node:path";

/** Suffixes stripped to find a file's "stem" (name shared by companions). */
const SUFFIXES = [
  ".spec.ts",
  ".spec.tsx",
  ".test.ts",
  ".test.tsx",
  ".stories.tsx",
  ".module.ts",
  ".d.ts",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".html",
  ".scss",
  ".css",
  ".vue",
  ".svelte",
];

/** A directory with more files than this is a barrel/asset dump — skip. */
const MAX_DIR_ENTRIES = 400;
const MAX_RESULTS = 12;

/**
 * Files that belong to the same unit of code as the given paths: the
 * Angular triplet (component.ts / .html / .scss / .spec.ts), a React
 * component and its test, a module and its stories.
 *
 * Import edges miss these — a template does not import its class — so a
 * task that edits one half of a component never sees the other half.
 * Feeding them in as context is what lets the model notice, e.g., that a
 * new template error state has no matching validator.
 */
export function companionFilesFor(
  workspaceRoot: string,
  relPaths: string[]
): string[] {
  const normalize = (p: string): string =>
    p.replace(/\\/g, "/").replace(/^\.\//, "");

  const stemOf = (fileName: string): string | null => {
    for (const suffix of SUFFIXES) {
      if (fileName.endsWith(suffix)) return fileName.slice(0, -suffix.length);
    }
    return null;
  };

  const readDir = (absDir: string): string[] => {
    try {
      const entries = fs.readdirSync(absDir, { withFileTypes: true });
      if (entries.length > MAX_DIR_ENTRIES) return [];
      return entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      return [];
    }
  };

  const found = new Set<string>();
  const dirCache = new Map<string, string[]>();
  const originals = new Set(relPaths.map(normalize));

  for (const relPath of relPaths) {
    const rel = normalize(relPath);
    const dir = path.posix.dirname(rel);
    const base = path.posix.basename(rel);
    const stem = stemOf(base);
    if (!stem) continue;

    let entries = dirCache.get(dir);
    if (!entries) {
      entries = readDir(path.join(workspaceRoot, dir));
      dirCache.set(dir, entries);
    }
    for (const entry of entries) {
      if (entry === base || stemOf(entry) !== stem) continue;
      const candidate = dir === "." ? entry : `${dir}/${entry}`;
      if (!originals.has(candidate)) found.add(candidate);
      if (found.size >= MAX_RESULTS) return [...found];
    }
  }
  return [...found];
}
