import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where the Codex CLI actually is on this machine.
 *
 * "codex" on PATH is the normal answer and the one tried first. It is not a
 * reliable one: the CLI is a global npm package, so it lives inside whichever
 * Node version installed it, and a version manager pointing elsewhere takes
 * it off PATH without uninstalling anything. That is not a hypothetical —
 * switching Node 20 → 24 made Codex vanish from the model picker, with
 * `codex login status` still reporting a signed-in account the moment the
 * old version was active again.
 *
 * Worse, the app is launched from Explorer, so it inherits the desktop's
 * PATH rather than a shell's. A CLI the user can run in their terminal may
 * simply not be visible to Atelier.
 *
 * So: PATH first, then the places a global npm install puts things. Resolved
 * once per process — an install mid-session is rare, and a stat per probe is
 * not worth it.
 */
let resolved: string | undefined;

const WINDOWS = process.platform === "win32";
const NAMES = WINDOWS ? ["codex.cmd", "codex.exe", "codex"] : ["codex"];

/** Directories a global npm install writes its shims into. */
function candidateDirs(): string[] {
  const home = os.homedir();
  const dirs: string[] = [];
  if (WINDOWS) {
    const appData = process.env.APPDATA;
    if (appData) dirs.push(path.join(appData, "npm"));
    const local = process.env.LOCALAPPDATA;
    if (local) {
      // nvm-for-Windows keeps one directory per installed Node version, and
      // global packages live inside them.
      dirs.push(...versionDirs(path.join(local, "nvm")));
    }
    const programFiles = process.env.ProgramFiles;
    if (programFiles) dirs.push(path.join(programFiles, "nodejs"));
  } else {
    dirs.push(
      "/usr/local/bin",
      "/opt/homebrew/bin",
      path.join(home, ".local", "bin"),
      path.join(home, ".npm-global", "bin"),
      ...versionDirs(path.join(home, ".nvm", "versions", "node")).map((dir) =>
        path.join(dir, "bin")
      )
    );
  }
  return dirs;
}

/** Version directories under a version manager's root. */
function versionDirs(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^v?\d+\./.test(entry.name))
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

/**
 * The command to spawn for Codex. Returns the bare name when PATH has it —
 * execa resolves that itself — and an absolute path when it does not.
 */
export function codexBinary(): string {
  if (resolved) return resolved;
  resolved = findOnPath() ?? findInCandidates() ?? "codex";
  return resolved;
}

/** Forgets the resolution — for a smoke that manipulates the environment. */
export function resetCodexBinary(): void {
  resolved = undefined;
}

function findOnPath(): string | null {
  const entries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of entries) {
    const hit = firstExisting(dir);
    // Already on PATH: spawn it by name so the OS resolves it as usual.
    if (hit) return "codex";
  }
  return null;
}

/**
 * The most RECENTLY INSTALLED shim among the candidates, not the one under
 * the highest Node version. Those are different answers and the difference
 * shows: a machine with Codex under both Node 20 and Node 22 offered the
 * older CLI's model list (gpt-5.5) when picked by Node version, and the
 * newer one (gpt-5.6) when picked by install time. The user upgraded the
 * CLI; they did not choose a Node version for it.
 */
function findInCandidates(): string | null {
  const hits: Array<{ file: string; mtimeMs: number }> = [];
  for (const dir of candidateDirs()) {
    const hit = firstExisting(dir);
    if (!hit) continue;
    try {
      hits.push({ file: hit, mtimeMs: fs.statSync(hit).mtimeMs });
    } catch {
      hits.push({ file: hit, mtimeMs: 0 });
    }
  }
  hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return hits[0]?.file ?? null;
}

function firstExisting(dir: string): string | null {
  for (const name of NAMES) {
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch {
      // not here
    }
  }
  return null;
}
