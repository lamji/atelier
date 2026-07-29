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
];

/**
 * Gitignore-aware workspace filter. Applied BEFORE watcher registration and
 * during tree walks so huge directories never enter the pipeline.
 */
export class WorkspaceIgnore {
  private ig: Ignore;

  constructor(private workspaceRoot: string, extraGlobs: string[] = []) {
    this.ig = ignore().add(DEFAULT_IGNORES).add(extraGlobs);
    const gitignorePath = path.join(workspaceRoot, ".gitignore");
    try {
      this.ig.add(fs.readFileSync(gitignorePath, "utf8"));
    } catch {
      // no .gitignore — defaults still apply
    }
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
