import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SlashCommand } from "@atelier/protocol";
import {
  GLOBAL_SESSION_COMMAND_ID,
  GLOBAL_SESSION_COMMAND_NAME,
} from "../context/global-session/index.js";
import {
  DEBUG_REPORT_PROMPT,
  DEBUG_REPORT_TEMPLATE,
  FEATURE_CONTEXT_COMMAND_ID,
  FEATURE_CONTEXT_COMMAND_NAME,
  FEATURE_CONTEXT_DEBUG_COMMAND_ID,
  FEATURE_CONTEXT_DEBUG_COMMAND_NAME,
  FEATURE_CONTEXT_UPDATE_COMMAND_ID,
  FEATURE_CONTEXT_UPDATE_COMMAND_NAME,
} from "../context/feature-context/index.js";

const GLOBAL_SESSION_COMMAND: SlashCommand = {
  id: GLOBAL_SESSION_COMMAND_ID,
  name: GLOBAL_SESSION_COMMAND_NAME,
  description:
    "Promote or update this conversation as detailed cross-session RAG memory.",
  kind: "command",
  scope: "project",
  enabled: true,
};

const GLOBAL_SESSION_DETAIL = `# Global session\n\n` +
  `Use /global-session to promote this conversation into the experimental ` +
  `cross-session knowledge index. The selected AI names it from the session. ` +
  `Running it again updates the same stable memory instead of duplicating it.`;

const FEATURE_CONTEXT_COMMAND: SlashCommand = {
  id: FEATURE_CONTEXT_COMMAND_ID,
  name: FEATURE_CONTEXT_COMMAND_NAME,
  description:
    "Equip this conversation with one end-to-end tree-sitter feature flow.",
  kind: "command",
  scope: "project",
  enabled: true,
};

const FEATURE_CONTEXT_DETAIL = `# Feature context\n\n` +
  `Use /context <feature> after naming a conversation for that work, for ` +
  `example /context login. Atelier maps matching indexed symbols and files, ` +
  `walks calls and imports end to end, and pins that compiled feature to this ` +
  `conversation. Claude and Codex receive the same map on every later send. ` +
  `Run /context_update to refresh it after a large code change.`;

const FEATURE_CONTEXT_UPDATE_COMMAND: SlashCommand = {
  id: FEATURE_CONTEXT_UPDATE_COMMAND_ID,
  name: FEATURE_CONTEXT_UPDATE_COMMAND_NAME,
  description:
    "Rebuild this conversation's pinned feature flow from the current index.",
  kind: "command",
  scope: "project",
  enabled: true,
};

const FEATURE_CONTEXT_UPDATE_DETAIL = `# Update feature context\n\n` +
  `Use /context_update when the code behind a pinned feature has moved on. ` +
  `It recompiles the map this conversation is already pinned to — no feature ` +
  `name to retype — waiting for indexing to catch up first, and reports the ` +
  `files that joined or left the flow. Pass a name (/context_update billing) ` +
  `to point the same conversation at a different feature. Nothing is pinned ` +
  `yet? Run /context <feature> first.`;

const FEATURE_CONTEXT_DEBUG_COMMAND: SlashCommand = {
  id: FEATURE_CONTEXT_DEBUG_COMMAND_ID,
  name: FEATURE_CONTEXT_DEBUG_COMMAND_NAME,
  description:
    "Report a defect on a form: steps to replicate, expected result, screenshots.",
  kind: "command",
  scope: "project",
  enabled: true,
};

/**
 * The detail IS the editor's starting document. A surface that can open a
 * markdown editor on a command loads this and gets the form; one that only
 * renders the detail as markdown still shows the user exactly what to fill
 * in. Either way there is one copy of the template.
 */
const FEATURE_CONTEXT_DEBUG_DETAIL = `# Debug report\n\n` +
  `Use /context_debug to hand Atelier a defect it can act on. The command ` +
  `answers with the report below; edit it and send it back under the same ` +
  `command. ${DEBUG_REPORT_PROMPT} Steps and expectation are then debugged ` +
  `against this conversation's pinned feature, so run /context <feature> ` +
  `first if the defect is somewhere the conversation has not been pointed ` +
  `at yet.\n\n` +
  "```markdown\n" +
  DEBUG_REPORT_TEMPLATE +
  "```\n";

/**
 * Discovers the app-owned skills plus the Claude Code-compatible commands
 * and skills used for a query:
 *
 *   <atelier>/skills/*\/SKILL.md        (app skills)
 *   <base>/.claude/commands/**\/*.md    (custom slash commands)
 *   <base>/.claude/skills/*\/SKILL.md   (skills, invocable as /name)
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
    FEATURE_CONTEXT_COMMAND,
    FEATURE_CONTEXT_UPDATE_COMMAND,
    FEATURE_CONTEXT_DEBUG_COMMAND,
    GLOBAL_SESSION_COMMAND,
    ...scanSkills(bundledSkillsRoot(), "app"),
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
  if (id === GLOBAL_SESSION_COMMAND_ID) {
    return { command: GLOBAL_SESSION_COMMAND, content: GLOBAL_SESSION_DETAIL };
  }
  if (id === FEATURE_CONTEXT_COMMAND_ID) {
    return { command: FEATURE_CONTEXT_COMMAND, content: FEATURE_CONTEXT_DETAIL };
  }
  if (id === FEATURE_CONTEXT_UPDATE_COMMAND_ID) {
    return {
      command: FEATURE_CONTEXT_UPDATE_COMMAND,
      content: FEATURE_CONTEXT_UPDATE_DETAIL,
    };
  }
  if (id === FEATURE_CONTEXT_DEBUG_COMMAND_ID) {
    return {
      command: FEATURE_CONTEXT_DEBUG_COMMAND,
      content: FEATURE_CONTEXT_DEBUG_DETAIL,
    };
  }
  const disabled = new Set(disabledSkills);
  for (const entry of scanSkillDetails(bundledSkillsRoot(), "app")) {
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
    { command: FEATURE_CONTEXT_COMMAND, content: FEATURE_CONTEXT_DETAIL },
    {
      command: FEATURE_CONTEXT_UPDATE_COMMAND,
      content: FEATURE_CONTEXT_UPDATE_DETAIL,
    },
    {
      command: FEATURE_CONTEXT_DEBUG_COMMAND,
      content: FEATURE_CONTEXT_DEBUG_DETAIL,
    },
    { command: GLOBAL_SESSION_COMMAND, content: GLOBAL_SESSION_DETAIL },
    ...scanSkillDetails(bundledSkillsRoot(), "app"),
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

/** Resolve source and packaged application skill directories. */
function bundledSkillsRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packaged = path.join(moduleDir, "skills");
  return fs.existsSync(packaged)
    ? packaged
    : path.resolve(moduleDir, "../../skills");
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
