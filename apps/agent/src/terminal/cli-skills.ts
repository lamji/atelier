import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CliSkillPaths {
  /** Holds `.claude/skills/<name>`; null when the app ships none. */
  root: string | null;
  skills: Array<{ name: string; file: string }>;
}

/** Beside the agent bundle — see scripts/copy-skills.mjs, which fills it. */
function bundledCliSkillsRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(moduleDir, "cli-skills");
}

/**
 * The app skills the provider CLIs can run, located inside the app itself.
 *
 * They are deliberately NOT installed into ~/.claude or ~/.codex: a skill
 * that came with Atelier has to leave with it, and a copy in the user's home
 * would outlive an uninstall.
 */
export function cliSkillPaths(
  root: string = bundledCliSkillsRoot()
): CliSkillPaths {
  const skillsDir = path.join(root, ".claude", "skills");
  let names: string[];
  try {
    names = fs.readdirSync(skillsDir);
  } catch {
    return { root: null, skills: [] };
  }
  const skills = names
    .map((name) => ({ name, file: path.join(skillsDir, name, "SKILL.md") }))
    .filter((skill) => fs.existsSync(skill.file));
  return { root: skills.length > 0 ? root : null, skills };
}
