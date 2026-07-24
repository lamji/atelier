import { execa } from "execa";
import { ok, warn, step, info } from "./ui.js";

export interface Prereq {
  name: string;
  probe: string[];
  /** winget id used to offer an install on Windows. */
  winget?: string;
  required: boolean;
  hint: string;
}

const PREREQS: Prereq[] = [
  {
    name: "Node.js 20",
    probe: ["node", "--version"],
    required: true,
    hint: "Install Node 20 LTS from https://nodejs.org",
  },
  {
    name: "Git",
    probe: ["git", "--version"],
    winget: "Git.Git",
    required: true,
    hint: "Install Git from https://git-scm.com",
  },
  {
    name: "GitHub CLI (gh)",
    probe: ["gh", "--version"],
    winget: "GitHub.cli",
    required: false,
    hint: "gh powers the Git flow / PR features. Install: winget install GitHub.cli",
  },
  {
    name: "Claude Code",
    probe: ["claude", "--version"],
    required: false,
    hint: "The agent authenticates via your Claude subscription. Run `claude` then /login.",
  },
];

async function has(cmd: string[]): Promise<string | null> {
  try {
    const result = await execa(cmd[0]!, cmd.slice(1), { reject: false });
    if (result.exitCode === 0) {
      return String(result.stdout || result.stderr).split("\n")[0]!.trim();
    }
  } catch {
    // not found
  }
  return null;
}

async function wingetAvailable(): Promise<boolean> {
  return (await has(["winget", "--version"])) !== null;
}

/**
 * Checks prerequisites; when `autoInstall` and winget is present, offers
 * to install missing tools that declare a winget id. Returns false only
 * when a REQUIRED prerequisite is missing.
 */
export async function runDoctor(autoInstall: boolean): Promise<boolean> {
  step("Checking prerequisites");
  const canWinget = autoInstall && (await wingetAvailable());
  let allRequiredOk = true;

  for (const prereq of PREREQS) {
    const version = await has(prereq.probe);
    if (version) {
      ok(`${prereq.name} ${info2(version)}`);
      continue;
    }
    if (canWinget && prereq.winget) {
      step(`Installing ${prereq.name} via winget…`);
      const result = await execa(
        "winget",
        ["install", "-e", "--id", prereq.winget, "--accept-source-agreements", "--accept-package-agreements"],
        { reject: false, stdio: "inherit" }
      );
      const nowVersion = await has(prereq.probe);
      if (result.exitCode === 0 && nowVersion) {
        ok(`${prereq.name} installed`);
        continue;
      }
    }
    if (prereq.required) {
      allRequiredOk = false;
      warn(`${prereq.name} is MISSING (required)`);
    } else {
      warn(`${prereq.name} not found (optional)`);
    }
    info(prereq.hint);
  }
  return allRequiredOk;
}

function info2(version: string): string {
  return version.length > 40 ? version.slice(0, 40) : version;
}
