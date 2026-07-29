import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceIgnore } from "../ignore.js";
import { describeProject } from "./describe-project.js";
import type { ProjectEntry, WorkspaceKind, WorkspaceProfile } from "./types.js";

/** Enough to characterize the workspace without turning into a tree walk. */
const MAX_PROJECTS = 14;

/** Marker file -> the workspace tool it implies. */
const MONOREPO_MARKERS: Array<[string, string]> = [
  ["pnpm-workspace.yaml", "pnpm workspaces"],
  ["nx.json", "nx"],
  ["lerna.json", "lerna"],
  ["turbo.json", "turborepo"],
  ["go.work", "go workspace"],
  ["rush.json", "rush"],
];

/**
 * Classifies the opened folder: a single project, a monorepo, or a
 * container holding several unrelated checkouts. The agent needs this
 * before its first tool call — in a container folder every path must be
 * prefixed with a project name, and "src/components" alone means nothing.
 *
 * Scans two levels only (depth 1 for projects, depth 2 for the apps/* and
 * packages/* shape), skipping ignored directories.
 */
export async function detectWorkspaceProfile(
  workspaceRoot: string,
  ignore?: WorkspaceIgnore
): Promise<WorkspaceProfile> {
  const ig = ignore ?? new WorkspaceIgnore(workspaceRoot);
  const rootProject = await describeProject(workspaceRoot, "", ig);

  const entries = await fs
    .readdir(workspaceRoot, { withFileTypes: true })
    .catch(() => []);
  const rootFiles = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  const childDirs = entries
    .filter((e) => e.isDirectory())
    .filter((e) => !ig.ignoresAbsolute(path.join(workspaceRoot, e.name), true))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  const projects: ProjectEntry[] = [];
  let truncated = false;
  for (const dir of childDirs) {
    if (projects.length >= MAX_PROJECTS) {
      truncated = true;
      break;
    }
    const abs = path.join(workspaceRoot, dir);
    const found = await describeProject(abs, dir, ig);
    if (found) {
      projects.push(found);
      continue;
    }
    // Not a project itself — look one level deeper for the apps/* and
    // packages/* shape a monorepo uses.
    const nested = await scanNested(abs, dir, ig, MAX_PROJECTS - projects.length);
    projects.push(...nested);
  }

  const monorepoTool = await detectMonorepoTool(workspaceRoot, rootFiles);
  return {
    rootName: path.basename(workspaceRoot) || workspaceRoot,
    kind: classify(rootProject, projects, monorepoTool),
    rootProject: rootProject ?? undefined,
    projects,
    monorepoTool,
    truncated,
  };
}

/**
 * A root with a build manifest is the project. A root that only has a
 * .git (or nothing) while holding several projects is a container — the
 * case where every tool path needs a project prefix, and the one that was
 * silently being reported as "a single project".
 */
function classify(
  rootProject: ProjectEntry | null,
  projects: ProjectEntry[],
  monorepoTool?: string
): WorkspaceKind {
  if (monorepoTool) return "monorepo";
  if (rootProject?.hasManifest) return "single-project";
  if (projects.length > 0) return "multi-project";
  if (rootProject) return "single-project";
  return "plain-folder";
}

/** Projects one level below a non-project directory (apps/*, packages/*). */
async function scanNested(
  absDir: string,
  relDir: string,
  ig: WorkspaceIgnore,
  budget: number
): Promise<ProjectEntry[]> {
  if (budget <= 0) return [];
  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: ProjectEntry[] = [];
  const dirs = entries
    .filter((e) => e.isDirectory())
    .filter((e) => !ig.ignoresAbsolute(path.join(absDir, e.name), true))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  for (const name of dirs) {
    if (found.length >= budget) break;
    const child = await describeProject(
      path.join(absDir, name),
      `${relDir}/${name}`,
      ig
    );
    if (child) found.push(child);
  }
  return found;
}

/** Workspace tooling at the root, if any. */
async function detectMonorepoTool(
  workspaceRoot: string,
  rootFiles: Set<string>
): Promise<string | undefined> {
  const marker = MONOREPO_MARKERS.find(([file]) => rootFiles.has(file));
  if (marker) return marker[1];
  if (rootFiles.has("package.json")) {
    const pkg = await readJson(path.join(workspaceRoot, "package.json"));
    if (pkg && "workspaces" in pkg) return "npm/yarn workspaces";
  }
  if (rootFiles.has("Cargo.toml")) {
    const toml = await readText(path.join(workspaceRoot, "Cargo.toml"));
    if (toml?.includes("[workspace]")) return "cargo workspace";
  }
  return undefined;
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  const text = await readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}
