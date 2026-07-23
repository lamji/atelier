/**
 * Wire paths are workspace-relative with forward slashes. These helpers keep
 * that invariant without depending on Node's path module (usable in browser).
 */
export function toPosix(p: string): string {
  return p.replaceAll("\\", "/");
}

export function normalizeRelPath(p: string): string {
  const posix = toPosix(p).replace(/^\.\//, "");
  return posix.replace(/^\/+/, "").replace(/\/+$/, "");
}

export function pathBasename(p: string): string {
  const norm = normalizeRelPath(p);
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? norm : norm.slice(idx + 1);
}

export function pathDirname(p: string): string {
  const norm = normalizeRelPath(p);
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? "" : norm.slice(0, idx);
}

/** Case-insensitive comparison (Windows-safe). */
export function pathsEqual(a: string, b: string): boolean {
  return normalizeRelPath(a).toLowerCase() === normalizeRelPath(b).toLowerCase();
}
