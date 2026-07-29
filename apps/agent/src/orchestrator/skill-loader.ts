import { approxTokens, clipToTokens } from "@atelier/shared";
import type { SlashCommand } from "@atelier/protocol";
import type { SettingsRepo } from "../storage/repositories/settings.js";
import { listSlashCommandDetails } from "./command-catalog.js";

const MAX_SKILL_TOKENS = 2000;
const MAX_TOTAL_TOKENS = 2400;

export interface LoadedSkill {
  id: string;
  name: string;
  description: string;
  scope: SlashCommand["scope"];
  content: string;
}

export interface SkillLoad {
  skills: LoadedSkill[];
  context: string;
}

const EMPTY: SkillLoad = { skills: [], context: "" };

/**
 * Loads ONLY the skill the user typed as a leading slash command.
 *
 * There used to be a "smart" router here that scored every skill against the
 * prompt, the intent and the retrieved chunks. It read every skill file on
 * every turn and injected up to three of them, so unrelated skills (an
 * Angular skill on a CSS question, an export skill on a payment question)
 * steered the answer and produced confident wrong conclusions. Skills are
 * opt-in now: no `/name`, no skill context.
 */
export class SkillLoader {
  constructor(
    private workspaceRoot: string,
    private settings: SettingsRepo
  ) {}

  load(prompt: string): SkillLoad {
    const name = leadingSlashName(prompt);
    if (!name) return EMPTY;

    const entry = listSlashCommandDetails(
      this.workspaceRoot,
      this.settings.get().disabledSkills
    ).find(
      (item) =>
        item.command.kind === "skill" &&
        item.command.enabled &&
        item.command.name.toLowerCase() === name
    );
    if (!entry) return EMPTY;

    const skill: LoadedSkill = {
      id: entry.command.id,
      name: entry.command.name,
      description: entry.command.description,
      scope: entry.command.scope,
      content: entry.content,
    };
    return { skills: [skill], context: renderSkillContext([skill]) };
  }
}

function renderSkillContext(skills: LoadedSkill[]): string {
  if (skills.length === 0) return "";
  const out = [
    "ATELIER INVOKED SKILLS",
    "The user invoked these skills for this task. Follow them; do not apply " +
      "any other skill.",
  ];
  let remaining = MAX_TOTAL_TOKENS;

  for (const skill of skills) {
    if (remaining <= 0) break;
    const header =
      `\n## /${skill.name} (${skill.scope})\n` +
      `Description: ${skill.description || "No description"}\n\n`;
    const body = clipToTokens(
      skill.content,
      Math.min(MAX_SKILL_TOKENS, remaining)
    );
    out.push(`${header}${body}`);
    remaining -= approxTokens(`${header}${body}`);
  }
  return `\n\n${out.join("\n")}\n`;
}

/**
 * Only a slash command at the very start of the prompt counts. Anything
 * later is prose — `/page-not-found` in a bug report is a route, not a skill.
 */
function leadingSlashName(prompt: string): string | null {
  const match = prompt.trim().match(/^\/([a-z0-9:_-]+)/i);
  return match?.[1]?.toLowerCase() ?? null;
}
