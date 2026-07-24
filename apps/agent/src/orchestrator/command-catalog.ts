import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SlashCommand } from "@atelier/protocol";

/**
 * Discovers the slash commands and skills the Claude Agent SDK will
 * load for a query — the same files Claude Code reads:
 *
 *   <base>/.claude/commands/**\/*.md   (custom slash commands)
 *   <base>/.claude/skills/*\/SKILL.md  (skills, invocable as /name)
 *
 * with <base> = the user's home dir ("user" scope) and the workspace
 * root ("project" scope). Scanned fresh per request so edits on disk
 * show up without restarting the agent.
 */
export function listSlashCommands(workspaceRoot: string): SlashCommand[] {
  const commands: SlashCommand[] = [
    ...scanBase(os.homedir(), "user"),
    ...scanBase(workspaceRoot, "project"),
  ];
  commands.sort((a, b) => a.name.localeCompare(b.name));
  return commands;
}

function scanBase(base: string, scope: SlashCommand["scope"]): SlashCommand[] {
  const root = path.join(base, ".claude");
  return [
    ...scanCommands(path.join(root, "commands"), "", scope),
    ...scanSkills(path.join(root, "skills"), scope),
  ];
}

/** Nested command dirs namespace the name Claude Code-style: a:b. */
function scanCommands(
  dir: string,
  prefix: string,
  scope: SlashCommand["scope"]
): SlashCommand[] {
  const entries = readDirSafe(dir);
  const out: SlashCommand[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...scanCommands(full, `${prefix}${entry.name}:`, scope));
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    const meta = parseFrontmatter(readFileSafe(full));
    out.push({
      name: `${prefix}${entry.name.slice(0, -3)}`,
      description: meta.description ?? firstProseLine(readFileSafe(full)),
      kind: "command",
      scope,
    });
  }
  return out;
}

function scanSkills(
  dir: string,
  scope: SlashCommand["scope"]
): SlashCommand[] {
  const out: SlashCommand[] = [];
  for (const entry of readDirSafe(dir)) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, "SKILL.md");
    const content = readFileSafe(skillFile);
    if (!content) continue;
    const meta = parseFrontmatter(content);
    out.push({
      name: meta.name ?? entry.name,
      description: meta.description ?? "",
      kind: "skill",
      scope,
    });
  }
  return out;
}

const MAX_DESCRIPTION = 140;

/** Minimal YAML frontmatter reader: top-level `name:`/`description:`. */
function parseFrontmatter(content: string): {
  name?: string;
  description?: string;
} {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end === -1) return {};
  const block = content.slice(3, end);
  const read = (key: string): string | undefined => {
    const match = block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    if (!match?.[1]) return undefined;
    return clip(match[1].trim().replace(/^["']|["']$/g, ""));
  };
  return { name: read("name"), description: read("description") };
}

/** Fallback description: the first non-frontmatter, non-heading line. */
function firstProseLine(content: string): string {
  let body = content;
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end !== -1) body = body.slice(end + 4);
  }
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  return clip(line ?? "");
}

function clip(text: string): string {
  return text.length > MAX_DESCRIPTION
    ? `${text.slice(0, MAX_DESCRIPTION - 1)}…`
    : text;
}

function readDirSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readFileSafe(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
