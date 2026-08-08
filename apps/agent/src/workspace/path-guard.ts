import path from "node:path";
import { normalizeRelPath, toPosix } from "@atelier/shared";

/** Read paths may reach an explicitly referenced file; writes never can. */
export type PathMode = "read" | "write";

/**
 * Canonicalizes every model- or client-supplied path and rejects escapes
 * from the workspace root. Wire format is workspace-relative POSIX-style.
 *
 * One exception: a path the user named themselves with an "@" mention that
 * happens to live outside the workspace is registered here as a *reference*
 * — readable, never writable. Nothing else can widen the guard, and the
 * allowance covers only the exact paths mentioned (a mentioned directory
 * covers its subtree), so pointing the agent at one file next door does not
 * open the rest of the disk.
 */
export class PathGuard {
  private rootLower: string;
  /** Lowercased absolute paths readable despite being outside the root. */
  private readRefs = new Set<string>();

  constructor(private workspaceRoot: string) {
    this.rootLower = path.resolve(workspaceRoot).toLowerCase();
  }

  /**
   * Marks an absolute path as readable. Returns false (and allows nothing)
   * for a relative path, so a malformed mention cannot widen the guard.
   */
  allowRead(absPath: string): boolean {
    if (!path.isAbsolute(absPath)) return false;
    this.readRefs.add(path.resolve(absPath).toLowerCase());
    return true;
  }

  /** True when `absPath` is a registered reference, or inside one. */
  private isReference(absPath: string): boolean {
    const lower = absPath.toLowerCase();
    for (const ref of this.readRefs) {
      if (lower === ref || lower.startsWith(ref + path.sep)) return true;
    }
    return false;
  }

  private isInRoot(absPath: string): boolean {
    const lower = absPath.toLowerCase();
    return lower === this.rootLower || lower.startsWith(this.rootLower + path.sep);
  }

  /**
   * Wire path -> absolute path, or throws on escape. A wire path is
   * workspace-relative; an absolute one is only accepted when reading a
   * registered reference.
   */
  toAbsolute(relPath: string, mode: PathMode = "write"): string {
    // An absolute wire path skips the relative normalizer, which would
    // otherwise fold "C:/x" into a root-relative path and hide the escape.
    const abs = path.isAbsolute(relPath)
      ? path.resolve(relPath)
      : path.resolve(this.workspaceRoot, normalizeRelPath(relPath));
    if (this.isInRoot(abs)) return abs;
    if (mode === "read" && this.isReference(abs)) return abs;
    throw new Error(`Path escapes workspace: ${relPath}`);
  }

  /**
   * Absolute path -> wire path. Registered references have no meaningful
   * workspace-relative form, so they travel as absolute posix paths — the
   * same text the user mentioned, which `toAbsolute(_, "read")` accepts.
   */
  toRelative(absPath: string): string {
    const abs = path.resolve(absPath);
    const rel = path.relative(this.workspaceRoot, abs);
    if (rel.startsWith("..")) {
      if (this.isReference(abs)) return toPosix(abs);
      throw new Error(`Path outside workspace: ${absPath}`);
    }
    return toPosix(rel);
  }
}
