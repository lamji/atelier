import fs from "node:fs/promises";
import path from "node:path";
import type { UserRule } from "@atelier/protocol";

/**
 * Rules the user writes, one markdown file each, kept in the workspace at
 * .atelier/rules and appended to the system rules on every run.
 *
 * Files rather than a settings blob on purpose: a rule is prose the user
 * edits, so it belongs in the same markdown editor as everything else in
 * .atelier — and it travels with the repo, which is where a team's
 * standing instructions want to live.
 *
 * Enabled state rides in the file's own frontmatter instead of a side
 * index: an index goes stale the moment someone moves or copies a file,
 * and the truth is then split across two places.
 */

export const RULES_DIR = ".atelier/rules";

/** Frontmatter block at the very top: --- \n enabled: true \n --- */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function rulesRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".atelier", "rules");
}

/** Workspace-relative, forward-slashed — the form the UI and fs RPCs use. */
function relPath(fileName: string): string {
  return `${RULES_DIR}/${fileName}`;
}

interface ParsedRule {
  enabled: boolean;
  /** Title from the first markdown heading, else the file name. */
  title: string;
  /** Everything after the frontmatter. */
  body: string;
}

function parseRule(fileName: string, raw: string): ParsedRule {
  const match = raw.match(FRONTMATTER_RE);
  const front = match?.[1] ?? "";
  const body = match ? raw.slice(match[0].length) : raw;
  // Absent frontmatter means a hand-dropped file; treat it as on, since a
  // rule someone bothered to write is meant to apply.
  const enabled = !/^\s*enabled\s*:\s*false\s*$/im.test(front);
  const heading = body.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
  const title = heading || fileName.replace(/\.md$/i, "");
  return { enabled, title, body };
}

/** Rewrites (or inserts) just the enabled flag, leaving the prose alone. */
function withEnabled(raw: string, enabled: boolean): string {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return `---\nenabled: ${enabled}\n---\n\n${raw}`;
  const front = match[1] ?? "";
  const updated = /^\s*enabled\s*:.*$/im.test(front)
    ? front.replace(/^\s*enabled\s*:.*$/im, `enabled: ${enabled}`)
    : `${front}\nenabled: ${enabled}`;
  return `---\n${updated}\n---\n${raw.slice(match[0].length)}`;
}

async function readRuleFiles(workspaceRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(rulesRoot(workspaceRoot), {
      withFileTypes: true,
    });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    // No rules folder yet is the normal empty case, not an error.
    return [];
  }
}

export async function listUserRules(workspaceRoot: string): Promise<UserRule[]> {
  const names = await readRuleFiles(workspaceRoot);
  const rules: UserRule[] = [];
  for (const name of names) {
    const raw = await fs
      .readFile(path.join(rulesRoot(workspaceRoot), name), "utf8")
      .catch(() => "");
    const parsed = parseRule(name, raw);
    rules.push({ path: relPath(name), title: parsed.title, enabled: parsed.enabled });
  }
  return rules;
}

/** Turns a typed name into a safe .md file name — no paths, no surprises. */
function fileNameFor(name: string): string {
  const base = name
    .trim()
    .replace(/\.md$/i, "")
    .replace(/[^\w .-]+/g, "-")
    .replace(/^[.\-\s]+|[.\-\s]+$/g, "")
    .slice(0, 80);
  if (!base) throw new Error("A rule needs a name");
  return `${base}.md`;
}

export async function createUserRule(
  workspaceRoot: string,
  name: string
): Promise<UserRule> {
  const fileName = fileNameFor(name);
  const dir = rulesRoot(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, fileName);
  const title = fileName.replace(/\.md$/i, "");
  const template =
    `---\nenabled: true\n---\n\n# ${title}\n\n` +
    "Write the rule here, the way you would say it to a teammate. " +
    "Everything below the heading is given to the agent verbatim.\n";
  // Never clobber a rule that already exists under this name.
  await fs.writeFile(file, template, { encoding: "utf8", flag: "wx" });
  return { path: relPath(fileName), title, enabled: true };
}

export async function setUserRuleEnabled(
  workspaceRoot: string,
  rulePath: string,
  enabled: boolean
): Promise<UserRule> {
  const fileName = path.basename(rulePath);
  const file = path.join(rulesRoot(workspaceRoot), fileName);
  const raw = await fs.readFile(file, "utf8");
  await fs.writeFile(file, withEnabled(raw, enabled), "utf8");
  const parsed = parseRule(fileName, raw);
  return { path: relPath(fileName), title: parsed.title, enabled };
}

export async function deleteUserRule(
  workspaceRoot: string,
  rulePath: string
): Promise<void> {
  const file = path.join(rulesRoot(workspaceRoot), path.basename(rulePath));
  await fs.rm(file, { force: true });
}

/**
 * The enabled rules as one block for the system prompt, or "" when there
 * are none. Read per turn rather than cached: a rule the user just edited
 * has to apply to the next run, not the next restart.
 */
export async function userRulesPrompt(workspaceRoot: string): Promise<string> {
  const names = await readRuleFiles(workspaceRoot);
  const blocks: string[] = [];
  for (const name of names) {
    const raw = await fs
      .readFile(path.join(rulesRoot(workspaceRoot), name), "utf8")
      .catch(() => "");
    const parsed = parseRule(name, raw);
    const body = parsed.body.trim();
    if (!parsed.enabled || !body) continue;
    blocks.push(body);
  }
  if (blocks.length === 0) return "";
  return (
    "\n\nUSER RULES — written by the user for this workspace. They are " +
    "additional to the rules above and, where they conflict on style or " +
    "process, they win:\n\n" +
    blocks.join("\n\n") +
    "\n"
  );
}
