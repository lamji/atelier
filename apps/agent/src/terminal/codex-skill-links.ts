import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Lists the app skills in Codex's own `$` menu, like any skill of its own,
 * and returns the names Codex now loads itself.
 *
 * Codex builds that menu only from fixed folders (`$CODEX_HOME/skills`,
 * `.agents/skills`); no setting adds another. So each app skill gets a link
 * there - a junction on Windows, a symlink elsewhere - that points into the
 * app, never a copy: the skill stays the app's, follows each app update,
 * and an uninstall leaves only a dead link, which Codex skips.
 *
 * Only links are ever written, replaced, or removed. A real folder with the
 * same name is the user's own skill and is left alone.
 */
export function linkCodexSkills(
  skills: ReadonlyArray<{ name: string; file: string }>,
  codexHome: string = defaultCodexHome()
): Set<string> {
  const linked = new Set<string>();
  const dir = path.join(codexHome, "skills");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return linked;
  }
  for (const skill of skills) {
    if (linkOne(path.join(dir, skill.name), path.dirname(skill.file))) {
      linked.add(skill.name);
    }
  }
  return linked;
}

function defaultCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/** True when `link` now points at `target`. */
function linkOne(link: string, target: string): boolean {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(link);
  } catch {
    // Nothing there yet.
  }
  if (stat && !stat.isSymbolicLink()) return false;
  if (stat && sameTarget(link, target)) return true;
  try {
    if (stat) fs.rmSync(link, { force: true });
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    // A skill Codex cannot list still runs when its name is typed.
    return false;
  }
}

/** True when `link` already resolves to `target`. */
function sameTarget(link: string, target: string): boolean {
  try {
    const current = path.resolve(path.dirname(link), fs.readlinkSync(link));
    return path.resolve(current).toLowerCase() === path.resolve(target).toLowerCase();
  } catch {
    return false;
  }
}
