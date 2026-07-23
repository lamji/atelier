import path from "node:path";
import { normalizeRelPath, toPosix } from "@atelier/shared";

/**
 * Canonicalizes every model- or client-supplied path and rejects escapes
 * from the workspace root. Wire format is workspace-relative POSIX-style.
 */
export class PathGuard {
  private rootLower: string;

  constructor(private workspaceRoot: string) {
    this.rootLower = path.resolve(workspaceRoot).toLowerCase();
  }

  /** Workspace-relative wire path -> absolute path, or throws on escape. */
  toAbsolute(relPath: string): string {
    const rel = normalizeRelPath(relPath);
    const abs = path.resolve(this.workspaceRoot, rel);
    const absLower = abs.toLowerCase();
    const inRoot =
      absLower === this.rootLower ||
      absLower.startsWith(this.rootLower + path.sep);
    if (!inRoot) {
      throw new Error(`Path escapes workspace: ${relPath}`);
    }
    return abs;
  }

  /** Absolute path -> workspace-relative wire path. */
  toRelative(absPath: string): string {
    const rel = path.relative(this.workspaceRoot, absPath);
    if (rel.startsWith("..")) {
      throw new Error(`Path outside workspace: ${absPath}`);
    }
    return toPosix(rel);
  }
}
