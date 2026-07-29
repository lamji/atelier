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
export function listSlashCommands(
  workspaceRoot: string,
  disabledSkills: string[] = []
): SlashCommand[] {
  const disabled = new Set(disabledSkills);
  const commands: SlashCommand[] = [
    ...scanBase(os.homedir(), "user"),
    ...scanBase(workspaceRoot, "project"),
  ].map((command) => ({
    ...command,
    enabled: command.kind !== "skill" || !disabled.has(command.id),
  }));
  commands.sort((a, b) => a.name.localeCompare(b.name));
  return commands;
}

export function readSlashCommandDetail(
  workspaceRoot: string,
  id: string,
  disabledSkills: string[] = []
): { command: SlashCommand; content: string } | null {
  const disabled = new Set(disabledSkills);
  for (const entry of scanDetails(os.homedir(), "user")) {
    if (entry.command.id === id) {
      return {
        command: {
          ...entry.command,
          enabled: entry.command.kind !== "skill" || !disabled.has(id),
        },
        content: entry.content,
      };
    }
  }
  for (const entry of scanDetails(workspaceRoot, "project")) {
    if (entry.command.id === id) {
      return {
        command: {
          ...entry.command,
          enabled: entry.command.kind !== "skill" || !disabled.has(id),
        },
        content: entry.content,
      };
    }
  }
  return null;
}

export function listSlashCommandDetails(
  workspaceRoot: string,
  disabledSkills: string[] = []
): Array<{ command: SlashCommand; content: string }> {
  const disabled = new Set(disabledSkills);
  const details = [
    ...scanDetails(os.homedir(), "user"),
    ...scanDetails(workspaceRoot, "project"),
  ].map((entry) => ({
    ...entry,
    command: {
      ...entry.command,
      enabled:
        entry.command.kind !== "skill" || !disabled.has(entry.command.id),
    },
  }));
  details.sort((a, b) => a.command.name.localeCompare(b.command.name));
  return details;
}

function scanBase(base: string, scope: SlashCommand["scope"]): SlashCommand[] {
  const root = path.join(base, ".claude");
  return [
    ...scanCommands(path.join(root, "commands"), "", scope),
    ...scanSkills(path.join(root, "skills"), scope),
  ];
}

function scanDetails(
  base: string,
  scope: SlashCommand["scope"]
): Array<{ command: SlashCommand; content: string }> {
  const root = path.join(base, ".claude");
  return [
    ...scanCommandDetails(path.join(root, "commands"), "", scope),
    ...scanSkillDetails(path.join(root, "skills"), scope),
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
      id: commandId(scope, "command", `${prefix}${entry.name.slice(0, -3)}`),
      name: `${prefix}${entry.name.slice(0, -3)}`,
      description: meta.description ?? firstProseLine(readFileSafe(full)),
      kind: "command",
      scope,
      enabled: true,
    });
  }
  return out;
}

function scanCommandDetails(
  dir: string,
  prefix: string,
  scope: SlashCommand["scope"]
): Array<{ command: SlashCommand; content: string }> {
  const entries = readDirSafe(dir);
  const out: Array<{ command: SlashCommand; content: string }> = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...scanCommandDetails(full, `${prefix}${entry.name}:`, scope));
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    const content = readFileSafe(full);
    const name = `${prefix}${entry.name.slice(0, -3)}`;
    const meta = parseFrontmatter(content);
    out.push({
      command: {
        id: commandId(scope, "command", name),
        name,
        description: meta.description ?? firstProseLine(content),
        kind: "command",
        scope,
        enabled: true,
      },
      content,
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
    const name = meta.name ?? entry.name;
    out.push({
      id: commandId(scope, "skill", name),
      name,
      description: meta.description ?? "",
      kind: "skill",
      scope,
      enabled: true,
    });
  }
  return out;
}

function scanSkillDetails(
  dir: string,
  scope: SlashCommand["scope"]
): Array<{ command: SlashCommand; content: string }> {
  const out: Array<{ command: SlashCommand; content: string }> = [];
  for (const entry of readDirSafe(dir)) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, "SKILL.md");
    const content = readFileSafe(skillFile);
    if (!content) continue;
    const meta = parseFrontmatter(content);
    const name = meta.name ?? entry.name;
    out.push({
      command: {
        id: commandId(scope, "skill", name),
        name,
        description: meta.description ?? "",
        kind: "skill",
        scope,
        enabled: true,
      },
      content,
    });
  }
  return out;
}

function commandId(
  scope: SlashCommand["scope"],
  kind: SlashCommand["kind"],
  name: string
): string {
  return `${scope}:${kind}:${name}`;
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
