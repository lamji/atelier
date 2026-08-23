import fs from "node:fs/promises";
import path from "node:path";
import { toPosix } from "@atelier/shared";
import type { WorkspaceIgnore } from "../ignore.js";

/**
 * Deep enough to reach the files themselves.
 *
 * Depth 3 was the old limit, and on a monorepo it spent the whole map
 * getting to `apps/web/src/` — one level above every folder the model
 * actually needed. The map has to reach `src/views/<area>/` and the files
 * in it, because that is where a guessed path goes wrong.
 */
const MAX_DEPTH = 5;

/**
 * The map's size cap, in characters, because that is what it costs. Lines
 * are not comparable to each other once each one carries a file list: a
 * container folder is 12 characters and a leaf folder of components is
 * 250, so a line budget prices them the same and a wide project blows the
 * prompt anyway.
 *
 * ~7 KB is about 1.7k tokens for the project a session is locked to — the
 * price of the model not guessing a path, which costs a wrong edit.
 */
const MAX_CHARS = 7_000;

/** A whole-workspace map (no scope lock) buys breadth, not depth: it has
 *  every checkout to cover and no idea yet which one matters, so it stops
 *  short of the leaf folders one project would spend the budget on. */
export const UNSCOPED_MAX_CHARS = 3_500;
export const UNSCOPED_MAX_DEPTH = 3;

/** Secondary cap: a project of thousands of tiny folders is a listing. */
const MAX_LINES = 300;

/** Per-level fan-out cap — one huge folder must not starve its siblings. */
const MAX_PER_LEVEL = 40;

/**
 * File names listed beside each directory. Enough to recognise the module
 * ("RightDock.tsx is in views/right/") without turning the map into a
 * listing; the count that follows says how much was left out.
 */
const MAX_FILES_PER_DIR = 10;

/** Names of files worth showing even in a directory full of them. */
const FILE_NAME_CHARS = 40;

/**
 * Top-level folders that get the budget first. Spending it alphabetically
 * let "docs" and a couple of sibling services consume the map before it
 * reached "src", which is the one folder the model is guaranteed to need.
 */
const SOURCE_FIRST = ["src", "app", "apps", "lib", "packages", "components"];

/** Noise that tells the model nothing about where code lives. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "release",
  "coverage",
  "__pycache__",
  "venv",
  "target",
  "vendor",
]);

/**
 * A map of one project: its directories AND the files in them.
 *
 * The workspace profile is depth-1 and rides on every turn, so it can only
 * ever say "src/ exists". That is exactly the knowledge that runs out at
 * the moment the model needs a real path, and convention fills the gap: it
 * writes src/components/sidebar/... because the last React project it saw
 * had one. This map is the missing half.
 *
 * It lists file names, not just folders, because the folder half alone did
 * not answer the question being guessed at. Knowing `views/right/` exists
 * still leaves "which file owns the editor pane?" to convention — and to a
 * list_dir round-trip per folder, which is the tax this block exists to
 * remove. Names are cheap: one line per directory carries both.
 */
export async function renderProjectTree(
  workspaceRoot: string,
  relRoot: string,
  ig: WorkspaceIgnore,
  maxChars = MAX_CHARS,
  maxDepth = MAX_DEPTH
): Promise<string> {
  const abs = path.resolve(workspaceRoot, relRoot);
  const budget = {
    chars: maxChars,
    lines: MAX_LINES,
    depth: maxDepth,
    truncated: false,
  };
  const lines: string[] = [];

  // The root's OWN files first — package.json, vite.config.ts, index.html.
  // The walk only ever reaches a directory's children, so without this the
  // map of a project silently omits the manifests that identify it.
  const rootFiles = await fileList(abs, ig, budget);
  if (rootFiles) lines.push(`./${rootFiles}`);
  await walk(abs, relRoot, 0, ig, budget, lines);
  if (lines.length === 0) return "";

  const label = toPosix(relRoot) || ".";
  const header =
    `DIRECTORY MAP — ${label}/ (real paths in this project, with the ` +
    `files in each folder. Use these names instead of guessing one; ` +
    `"+N" means N more files not listed.)`;
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
  budget: Budget,
  lines: string[]
): Promise<void> {
  if (depth >= budget.depth || spent(budget)) return;

  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }

  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .filter((e) => !SKIP_DIRS.has(e.name))
    .filter((e) => !ig.ignoresAbsolute(path.join(absDir, e.name), true))
    .map((e) => e.name)
    .sort((a, b) =>
      depth === 0 ? compareSourceFirst(a, b) : a.localeCompare(b)
    );

  const shown = dirs.slice(0, MAX_PER_LEVEL);
  if (shown.length < dirs.length) budget.truncated = true;

  for (const name of shown) {
    if (spent(budget)) {
      budget.truncated = true;
      return;
    }
    const rel = relDir ? `${relDir}/${name}` : name;
    const childAbs = path.join(absDir, name);
    const indent = "  ".repeat(depth);
    const line = `${indent}${name}/${await fileList(childAbs, ig, budget)}`;
    budget.chars -= line.length + 1;
    budget.lines -= 1;
    lines.push(line);
    await walk(childAbs, rel, depth + 1, ig, budget, lines);
  }
}

/** What the walk has left to spend, and whether anything was left out. */
interface Budget {
  chars: number;
  lines: number;
  depth: number;
  truncated: boolean;
}

function spent(budget: Budget): boolean {
  return budget.chars <= 0 || budget.lines <= 0;
}

/**
 * The files directly inside one directory, as a trailing fragment of that
 * directory's own line. Returns "" for a directory that only holds other
 * directories, so a pure container costs exactly what it did before.
 */
async function fileList(
  absDir: string,
  ig: WorkspaceIgnore,
  budget: Budget
): Promise<string> {
  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return "";
  }
  const files = entries
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .filter((e) => !ig.ignoresAbsolute(path.join(absDir, e.name), false))
    .filter((e) => e.name.length <= FILE_NAME_CHARS)
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  if (files.length === 0) return "";

  const shown = files.slice(0, MAX_FILES_PER_DIR);
  const rest = files.length - shown.length;
  if (rest > 0) budget.truncated = true;
  return `  ${shown.join(" ")}${rest > 0 ? ` +${rest}` : ""}`;
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
