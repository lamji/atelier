import fs from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { toPosix } from "@atelier/shared";

const DEFAULT_IGNORES = [
  ".git/",
  // The app's own cache (notes/prompt .md files); it has a dedicated
  // catalog (fs.markdownFiles) and must stay out of tree/search/index.
  ".atelier/",
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  "coverage/",
  ".vite/",
  ".next/",
  ".turbo/",
  "*.log",
  ".DS_Store",
  // Electron archives. Nothing here can read one, and on an Electron-forked
  // host the fs shim treats the path as an archive rather than a file.
  "*.asar",
];

const ATELIER_GITIGNORE_ENTRY = ".atelier/";

function findGitRoot(workspaceRoot: string): string | null {
  let current = path.resolve(workspaceRoot);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Keeps Atelier's project-local cache out of Git without disturbing the
 * project's existing ignore rules. Returns true only when a rule was added.
 */
export function ensureAtelierGitignored(workspaceRoot: string): boolean {
  const gitRoot = findGitRoot(workspaceRoot);
  if (!gitRoot) return false;

  const gitignorePath = path.join(gitRoot, ".gitignore");
  let existing = "";
  try {
    existing = fs.readFileSync(gitignorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (ignore().add(existing).ignores(`${ATELIER_GITIGNORE_ENTRY}.keep`)) {
    return false;
  }

  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const separator =
    existing.length > 0 && !existing.endsWith("\n") && !existing.endsWith("\r")
      ? eol
      : "";
  fs.appendFileSync(
    gitignorePath,
    `${separator}${ATELIER_GITIGNORE_ENTRY}${eol}`,
    "utf8"
  );
  return true;
}

/**
 * Gitignore-aware workspace filter. Applied BEFORE watcher registration and
 * during tree walks so huge directories never enter the pipeline.
 */
export class WorkspaceIgnore {
  private ig: Ignore;
  /** The built-in noise list ONLY, without the project's .gitignore. */
  private noise: Ignore;

  constructor(private workspaceRoot: string, extraGlobs: string[] = []) {
    this.ig = ignore().add(DEFAULT_IGNORES).add(extraGlobs);
    this.noise = ignore().add(DEFAULT_IGNORES).add(extraGlobs);
    const gitignorePath = path.join(workspaceRoot, ".gitignore");
    try {
      this.ig.add(fs.readFileSync(gitignorePath, "utf8"));
    } catch {
      // no .gitignore — defaults still apply
    }
  }

  /**
   * Whether the FILE EXPLORER should hide this path.
   *
   * Deliberately weaker than `ignores`: it applies the built-in noise list
   * (node_modules, .git, build output) and NOT the project's .gitignore.
   *
   * Those are two different questions that were being answered by one rule,
   * and the cost was real: `.env` is gitignored in every sane project, so
   * the explorer refused to show a file the user had just created and was
   * actively editing. Git ignoring a file means "do not commit it", not "do
   * not let me see it" — VS Code shows it, and so should this.
   *
   * The stricter `ignores` still guards the index, the watcher and search,
   * which is where a .env genuinely does not belong: nothing gitignored is
   * embedded, retrieved, or sent to a model.
   */
  hiddenFromTree(relPath: string, isDir = false): boolean {
    const posix = toPosix(relPath);
    if (!posix || posix === ".") return false;
    return this.noise.ignores(isDir ? `${posix}/` : posix);
  }

  hiddenFromTreeAbsolute(absPath: string, isDir = false): boolean {
    const rel = path.relative(this.workspaceRoot, absPath);
    if (!rel || rel.startsWith("..")) return false;
    return this.hiddenFromTree(rel, isDir);
  }

  /** relPath is workspace-relative; dirs may pass a trailing slash. */
  ignores(relPath: string, isDir = false): boolean {
    const posix = toPosix(relPath);
    if (!posix || posix === ".") return false;
    return this.ig.ignores(isDir ? `${posix}/` : posix);
  }

  ignoresAbsolute(absPath: string, isDir = false): boolean {
    const rel = path.relative(this.workspaceRoot, absPath);
    if (!rel || rel.startsWith("..")) return false;
    return this.ignores(rel, isDir);
  }
}
