import type { Db } from "../../storage/db.js";

/**
 * Resolves TS/JS import specifiers to indexed workspace files. Relative
 * specifiers get extension/index probing (including ESM ".js" -> ".ts");
 * "@/x" aliases probe common source roots. External packages resolve to
 * null. Lookups hit the files table so resolution is always current.
 */
export class ImportResolver {
  constructor(private db: Db) {}

  private fileId(relPath: string): number | null {
    const row = this.db
      .prepare("SELECT id FROM files WHERE path = ?")
      .get(relPath) as { id: number } | undefined;
    return row?.id ?? null;
  }

  /** Candidate wire paths for a specifier imported from importerPath. */
  candidates(importerPath: string, specifier: string): string[] {
    if (specifier.startsWith(".")) {
      const dir = importerPath.includes("/")
        ? importerPath.slice(0, importerPath.lastIndexOf("/"))
        : "";
      return probeCandidates(normalize(`${dir}/${specifier}`));
    }
    if (specifier.startsWith("@/")) {
      // Vite/tsconfig alias: probe common roots relative to the importer's
      // package (apps/web/src) and the workspace root (src/).
      const rest = specifier.slice(2);
      const roots = aliasRoots(importerPath);
      return roots.flatMap((root) => probeCandidates(normalize(`${root}/${rest}`)));
    }
    // Monorepo workspace packages ("@atelier/shared", "@x/y/sub"): probe
    // conventional package roots. External npm packages simply miss every
    // probe and stay unresolved — exactly right.
    return workspacePackageCandidates(specifier);
  }

  /** Resolve to a files.id, or null when external/unindexed. */
  resolve(importerPath: string, specifier: string): number | null {
    for (const candidate of this.candidates(importerPath, specifier)) {
      const id = this.fileId(candidate);
      if (id !== null) return id;
    }
    return null;
  }

  /**
   * True when `specifier` (imported from importerPath) could resolve to
   * `targetPath` — used to re-resolve dangling imports when files appear.
   */
  couldResolveTo(
    importerPath: string,
    specifier: string,
    targetPath: string
  ): boolean {
    return this.candidates(importerPath, specifier).some(
      (c) => c.toLowerCase() === targetPath.toLowerCase()
    );
  }
}

function normalize(p: string): string {
  const parts: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function probeCandidates(base: string): string[] {
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mts`,
    `${base}.cjs`,
    `${base}.mjs`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
  // Imports like "./auth.js" in ESM TS actually point at auth.ts.
  if (/\.(js|mjs|cjs)$/.test(base)) {
    const stem = base.replace(/\.(js|mjs|cjs)$/, "");
    candidates.push(`${stem}.ts`, `${stem}.tsx`);
  }
  return candidates;
}

/**
 * Candidates for a bare package specifier inside this monorepo:
 * "@atelier/shared" -> packages/shared/src/index.ts (etc.);
 * "@atelier/shared/paths" -> packages/shared/src/paths.ts.
 */
function workspacePackageCandidates(specifier: string): string[] {
  const parts = specifier.split("/");
  const scoped = specifier.startsWith("@");
  if (scoped && parts.length < 2) return [];
  const pkg = scoped ? parts[1]! : parts[0]!;
  const sub = parts.slice(scoped ? 2 : 1).join("/");
  if (!pkg) return [];
  const out: string[] = [];
  for (const root of [`packages/${pkg}`, `libs/${pkg}`, `apps/${pkg}`]) {
    if (sub) {
      out.push(
        ...probeCandidates(normalize(`${root}/src/${sub}`)),
        ...probeCandidates(normalize(`${root}/${sub}`))
      );
    } else {
      out.push(
        ...probeCandidates(`${root}/src/index`),
        ...probeCandidates(`${root}/index`),
        ...probeCandidates(`${root}/src/main`)
      );
    }
  }
  return out;
}

/** Probable roots the "@/" alias maps to, nearest package first. */
function aliasRoots(importerPath: string): string[] {
  const roots: string[] = [];
  const segments = importerPath.split("/");
  const srcIdx = segments.lastIndexOf("src");
  if (srcIdx > 0) roots.push(segments.slice(0, srcIdx + 1).join("/"));
  roots.push("src");
  return [...new Set(roots)];
}
