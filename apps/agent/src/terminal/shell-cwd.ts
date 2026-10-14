import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { readlink } from "node:fs/promises";
import { promisify } from "node:util";

/**
 * Knowing where a terminal's shell currently is.
 *
 * A PTY is opaque: the user types `cd`, and nothing outside the shell is
 * told. Restoring a terminal in the directory it was left in therefore needs
 * the shell to say where it is, and there are two ways to get that:
 *
 *  - Windows: PowerShell's prompt is wrapped so every prompt is preceded by
 *    an OSC sequence carrying the location. ConPTY passes unknown OSCs
 *    through and xterm ignores them, so it costs nothing on screen.
 *  - POSIX: the kernel already knows, so the shell's cwd is read from the
 *    process itself and no shell has to cooperate.
 */

const execFileAsync = promisify(execFile);

/** Private-use OSC, the same shape VS Code's shell integration uses. */
const CWD_OSC = "633;P;Cwd=";
/** An OSC longer than this is not a path report; stop waiting for its end. */
const MAX_PENDING_OSC = 4096;

/**
 * Wraps whatever prompt the profile installed (oh-my-posh, starship, the
 * default) instead of replacing it, and stays silent off the filesystem
 * provider — `cd HKLM:` has no directory to come back to.
 */
const POWERSHELL_PROMPT_HOOK = [
  "$global:__atelierPrompt = $function:prompt",
  "function global:prompt {",
  "  $loc = $executionContext.SessionState.Path.CurrentLocation",
  '  $text = (& $global:__atelierPrompt) -join "`n"',
  "  if ($loc.Provider.Name -ne 'FileSystem') { return $text }",
  `  "$([char]27)]${CWD_OSC}$($loc.ProviderPath)$([char]7)$text"`,
  "}",
].join("\n");

export interface ShellLaunch {
  file: string;
  args: string[];
}

/** The interactive shell to spawn, with cwd reporting switched on. */
export function shellLaunch(): ShellLaunch {
  if (process.platform !== "win32") {
    return { file: process.env.SHELL ?? "bash", args: [] };
  }
  // -EncodedCommand (UTF-16LE base64) sidesteps command-line quoting; the
  // profile still loads first, which is what lets the hook wrap its prompt.
  const encoded = Buffer.from(POWERSHELL_PROMPT_HOOK, "utf16le").toString(
    "base64"
  );
  return {
    file: "powershell.exe",
    args: ["-NoExit", "-EncodedCommand", encoded],
  };
}

// Group 1: our own report. Group 2: OSC 7 (`file://host/path`), which fish
// and some zsh/bash setups emit unprompted.
const CWD_REPORT =
  /\x1b\](?:633;P;Cwd=([^\x07\x1b]*)|7;file:\/\/[^/\x07\x1b]*([^\x07\x1b]*))(?:\x07|\x1b\\)/g;

function fromFileUrlPath(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw);
    // file:///C:/dir arrives as /C:/dir.
    return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
  } catch {
    return null;
  }
}

/**
 * Pulls cwd reports out of a PTY's output stream. Stateful because the PTY
 * chunks wherever it likes: a report split across two reads is held until
 * its terminator arrives.
 */
export class CwdScanner {
  private pending = "";

  /** The most recent cwd reported in this chunk, or null when none was. */
  push(data: string): string | null {
    const text = this.pending + data;
    let latest: string | null = null;
    let consumed = 0;
    CWD_REPORT.lastIndex = 0;
    for (
      let match = CWD_REPORT.exec(text);
      match;
      match = CWD_REPORT.exec(text)
    ) {
      const cwd = match[1] ?? fromFileUrlPath(match[2] ?? "");
      if (cwd) latest = cwd;
      consumed = CWD_REPORT.lastIndex;
    }
    this.pending = unfinishedOsc(text.slice(consumed));
    return latest;
  }
}

/** The tail of `text` that may still turn into a report, else "". */
function unfinishedOsc(text: string): string {
  if (text.endsWith("\x1b")) return "\x1b";
  const start = text.lastIndexOf("\x1b]");
  if (start === -1) return "";
  const tail = text.slice(start);
  if (tail.length > MAX_PENDING_OSC) return "";
  const terminated = tail.includes("\x07") || tail.includes("\x1b\\");
  return terminated ? "" : tail;
}

/**
 * Where a process currently is, asked of the OS. POSIX only — Windows has no
 * supported way to read another process's cwd, hence the prompt hook.
 */
export async function probeProcessCwd(pid: number): Promise<string | null> {
  try {
    if (process.platform === "linux") {
      return await readlink(`/proc/${pid}/cwd`);
    }
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("lsof", [
        "-a",
        "-d",
        "cwd",
        "-p",
        String(pid),
        "-Fn",
      ]);
      const line = stdout.split("\n").find((l) => l.startsWith("n"));
      return line ? line.slice(1) : null;
    }
  } catch {
    // Process gone, or not readable — no report this time.
  }
  return null;
}

/** True when `dir` can be handed to a shell as its starting directory. */
export function isUsableDir(dir: string | undefined): dir is string {
  if (!dir) return false;
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function normalizeDir(dir: string): string {
  const trimmed = dir.length > 3 ? dir.replace(/[\\/]+$/, "") : dir;
  if (process.platform !== "win32") return trimmed;
  return trimmed.replace(/\//g, "\\").toLowerCase();
}

export function sameDir(a: string, b: string): boolean {
  return normalizeDir(a) === normalizeDir(b);
}
