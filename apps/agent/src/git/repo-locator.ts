import fs from "node:fs";
import path from "node:path";

/** How deep below the workspace root a sibling checkout may be found. */
const MAX_SCAN_DEPTH = 2;

/** Directories that never hold a project checkout worth scanning. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  "vendor",
  "target",
  "__pycache__",
]);

/**
 * Finds the git repository a workspace path belongs to.
 *
 * A workspace root is not necessarily a repo: opening a folder that holds
 * several checkouts side by side is the normal case, and there every git
 * operation belongs to whichever checkout the touched file lives in. The
 * search walks UP from the path — the opposite of `git rev-parse`, which
 * would escape the workspace and find the user's home-directory repo.
 */
export function findRepoRoot(
  workspaceRoot: string,
  relPath: string
): string | null {
  const root = path.resolve(workspaceRoot);
  let dir = path.resolve(root, relPath || ".");

  // A file path resolves to its own name; start the walk at its folder.
  if (isFile(dir)) dir = path.dirname(dir);

  while (dir.startsWith(root)) {
    if (isRepoRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Whether a directory is a usable checkout.
 *
 * The presence of ".git" is NOT enough. A leftover empty .git directory
 * is a real thing to find at the top of a folder full of checkouts, and
 * treating it as a repo is worse than finding nothing: it shadows every
 * real checkout below it and then fails on the first command. Requiring
 * HEAD is the cheapest check that tells the two apart.
 */
export function isRepoRoot(dir: string): boolean {
  const marker = path.join(dir, ".git");
  if (isDir(marker)) return isFile(path.join(marker, "HEAD"));
  // A .git FILE is a worktree or submodule pointer at the real gitdir.
  if (isFile(marker)) return readsAsGitdir(marker);
  return false;
}

function readsAsGitdir(marker: string): boolean {
  try {
    return fs.readFileSync(marker, "utf8").startsWith("gitdir:");
  } catch {
    return false;
  }
}

/**
 * Every checkout inside the workspace, nearest first. Used to name real
 * candidates when a git call cannot be routed, instead of telling the
 * model "the workspace is not a git repository" while three repos sit one
 * level down.
 */
export function listRepoRoots(workspaceRoot: string): string[] {
  const root = path.resolve(workspaceRoot);
  const found: string[] = [];
  walk(root, root, 0, found);
  return found;
}

function walk(
  dir: string,
  root: string,
  depth: number,
  found: string[]
): void {
  if (isRepoRoot(dir)) {
    found.push(dir);
    // A nested checkout below a repo is a submodule; the parent owns it.
    return;
  }
  if (depth >= MAX_SCAN_DEPTH) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    walk(path.join(dir, entry.name), root, depth + 1, found);
  }
}

/**
 * When a checkout was last worked in, as an epoch ms.
 *
 * `.git/index` is rewritten by stage, commit and checkout, so it tracks
 * real activity far better than the working tree, which a background
 * build can touch. Used to pick a sensible default checkout in a folder
 * that holds several — the one you were last in beats an alphabetical
 * guess.
 */
export function repoActivityAt(repoRoot: string): number {
  const gitDir = path.join(repoRoot, ".git");
  const times = ["index", "HEAD"].map((name) => {
    try {
      return fs.statSync(path.join(gitDir, name)).mtimeMs;
    } catch {
      return 0;
    }
  });
  return Math.max(...times);
}

/** Workspace-relative posix label for a repo root ("" = the root itself). */
export function repoLabel(workspaceRoot: string, repoRoot: string): string {
  const rel = path.relative(path.resolve(workspaceRoot), repoRoot);
  return rel === "" ? "." : rel.split(path.sep).join("/");
}

function isDir(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}
