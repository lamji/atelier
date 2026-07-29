import fs from "node:fs/promises";
import path from "node:path";
import { toPosix } from "@atelier/shared";
import type { WorkspaceIgnore } from "../ignore.js";
import type { ProjectEntry } from "./types.js";

const MAX_TOP_DIRS = 8;

/** Manifest file -> base stack label, checked in this order. */
const MANIFESTS: Array<[string, string]> = [
  ["package.json", "node"],
  ["go.mod", "go"],
  ["Cargo.toml", "rust"],
  ["pyproject.toml", "python"],
  ["requirements.txt", "python"],
  ["pom.xml", "java/maven"],
  ["build.gradle", "java/gradle"],
  ["build.gradle.kts", "java/gradle"],
  ["composer.json", "php"],
  ["Gemfile", "ruby"],
  ["pubspec.yaml", "dart/flutter"],
];

/** Dependency -> framework suffix. First match wins, so order matters. */
const FRAMEWORKS: Array<[string, string]> = [
  ["next", "next"],
  ["nuxt", "nuxt"],
  ["@angular/core", "angular"],
  ["@nestjs/core", "nest"],
  ["electron", "electron"],
  ["react", "react"],
  ["vue", "vue"],
  ["svelte", "svelte"],
  ["express", "express"],
  ["fastify", "fastify"],
];

/**
 * Probes one directory and reports it as a project when it carries a
 * manifest or its own git checkout. Returns null for ordinary folders, so
 * the caller can tell "contains projects" from "is a pile of files".
 */
export async function describeProject(
  absDir: string,
  relPath: string,
  ig: WorkspaceIgnore
): Promise<ProjectEntry | null> {
  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const names = new Set(entries.map((e) => e.name));
  const isGitRepo = names.has(".git");
  const manifest = MANIFESTS.find(([file]) => names.has(file));
  const dotnet = [...names].some((n) => /\.(csproj|sln)$/i.test(n));
  if (!manifest && !dotnet && !isGitRepo) return null;

  let stack = manifest?.[1] ?? (dotnet ? "dotnet" : "unknown");
  if (manifest?.[0] === "package.json") {
    const framework = await detectFramework(path.join(absDir, "package.json"));
    if (framework) stack = `node/${framework}`;
  }

  // Dot-directories are tool config, never source. Listing them first
  // alphabetically pushed the one directory that matters (src) past the
  // cap, so they are dropped outright.
  const topDirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .filter((e) => !ig.ignoresAbsolute(path.join(absDir, e.name), true))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_TOP_DIRS);

  return {
    path: toPosix(relPath),
    name: path.basename(absDir),
    stack,
    hasManifest: manifest !== undefined || dotnet,
    isGitRepo,
    topDirs,
  };
}

/** Reads package.json deps for the framework that defines the project. */
async function detectFramework(pkgPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const hit = FRAMEWORKS.find(([dep]) => deps[dep] !== undefined);
    return hit?.[1] ?? null;
  } catch {
    return null;
  }
}
