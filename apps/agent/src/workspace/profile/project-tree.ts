import fs from "node:fs/promises";
import path from "node:path";
import { toPosix } from "@atelier/shared";
import type { WorkspaceIgnore } from "../ignore.js";

/** Deep enough to reach src/components/<feature>, which is where the
 *  model's guesses actually go wrong; deeper turns into a file listing. */
const MAX_DEPTH = 3;

/** Hard cap so a sprawling project cannot flood the prompt. */
const MAX_DIRS = 160;

/** Per-level fan-out cap — one huge folder must not starve its siblings. */
const MAX_PER_LEVEL = 40;

/**
 * Top-level folders that get the budget first. Spending it alphabetically
 * let "docs" and a couple of sibling services consume the map before it
 * reached "src", which is the one folder the model is guaranteed to need.
 */
const SOURCE_FIRST = ["src", "app", "lib", "packages", "apps", "components"];

/**
 * Directory-only map of one project, as indented lines.
 *
 * The workspace profile is depth-1 and rides on every turn, so it can only
 * ever say "src/ exists". That is exactly the knowledge that runs out at
 * the moment the model needs a real path, and convention fills the gap:
 * it writes src/components/sidebar/... because the last React project it
 * saw had one. This map is the missing half — it is scoped to the project
 * the session is locked to, so the cost is paid once for the folder being
 * worked in rather than for every checkout in the workspace.
 */
export async function renderProjectTree(
  workspaceRoot: string,
  relRoot: string,
  ig: WorkspaceIgnore
): Promise<string> {
  const abs = path.resolve(workspaceRoot, relRoot);
  const budget = { left: MAX_DIRS, truncated: false };
  const lines: string[] = [];

  await walk(abs, relRoot, 0, ig, budget, lines);
  if (lines.length === 0) return "";

  const label = toPosix(relRoot) || ".";
  const header = `DIRECTORY MAP — ${label}/ (directories only, depth ${MAX_DEPTH})`;
  const footer = budget.truncated
    ? "\n(map truncated — list_dir any folder above for the rest)"
    : "";
  return `${header}\n${lines.join("\n")}${footer}\n`;
}

async function walk(
  absDir: string,
  relDir: string,
  depth: number,
  ig: WorkspaceIgnore,
  budget: { left: number; truncated: boolean },
  lines: string[]
): Promise<void> {
  if (depth >= MAX_DEPTH || budget.left <= 0) return;

  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }

  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .filter((e) => !ig.ignoresAbsolute(path.join(absDir, e.name), true))
    .map((e) => e.name)
    .sort((a, b) =>
      depth === 0 ? compareSourceFirst(a, b) : a.localeCompare(b)
    );

  const shown = dirs.slice(0, MAX_PER_LEVEL);
  if (shown.length < dirs.length) budget.truncated = true;

  for (const name of shown) {
    if (budget.left <= 0) {
      budget.truncated = true;
      return;
    }
    budget.left -= 1;
    const rel = relDir ? `${relDir}/${name}` : name;
    lines.push(`${"  ".repeat(depth)}${name}/`);
    await walk(path.join(absDir, name), rel, depth + 1, ig, budget, lines);
  }
}

/** Source folders before everything else, then alphabetical within each. */
function compareSourceFirst(a: string, b: string): number {
  const rankA = SOURCE_FIRST.indexOf(a);
  const rankB = SOURCE_FIRST.indexOf(b);
  if (rankA !== rankB) {
    if (rankA === -1) return 1;
    if (rankB === -1) return -1;
    return rankA - rankB;
  }
  return a.localeCompare(b);
}
