import path from "node:path";
import { spawn } from "node:child_process";
import { execa } from "execa";
import type pino from "pino";
import type { PathGuard } from "../workspace/path-guard.js";
import type { ToolRegistry } from "./registry.js";
import { ShellSession } from "./shell-session.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 60_000;

/** How much command output reaches the log for one call. */
const MAX_LOGGED_OUTPUT = 4_000;

/**
 * Best-effort workspace confinement for shell commands: rejects commands
 * that reference absolute paths outside the workspace root, environment
 * home shortcuts, or parent-directory traversal. The agent must only work
 * inside the current project.
 */
export function assertCommandConfined(
  command: string,
  workspaceRoot: string
): void {
  const rootLower = path.resolve(workspaceRoot).toLowerCase();

  const drivePaths = command.match(/[A-Za-z]:[\\/][^\s"'`;|&<>)]*/g) ?? [];
  for (const raw of drivePaths) {
    const resolved = path.resolve(raw).toLowerCase();
    const inRoot =
      resolved === rootLower || resolved.startsWith(rootLower + path.sep);
    if (!inRoot) {
      throw new Error(
        `Command blocked: "${raw}" is outside the workspace. ` +
          "This agent may only operate inside the current project directory."
      );
    }
  }

  const escapePatterns = [
    /%(userprofile|appdata|localappdata|homepath|home)%/i,
    /\$env:(userprofile|appdata|localappdata|home)/i,
    /(^|[\s"'`;|&])~[\\/]/,
    /(^|[\s"'`;|&(])\.\.[\\/]/,
    /\bcd\s+\.\.(\s|$)/i,
  ];
  for (const pattern of escapePatterns) {
    if (pattern.test(command)) {
      throw new Error(
        "Command blocked: it references a location outside the workspace " +
          "(home directory, environment path, or parent traversal). " +
          "This agent may only operate inside the current project directory."
      );
    }
  }
}

export interface RunTerminalInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface RunTerminalResult {
  exitCode: number | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * Registers the run_terminal tool: executes a shell command (PowerShell on
 * Windows), streaming output as tool.output events. Cancellation propagates
 * through the task abort signal.
 */
export function registerTerminalTools(
  registry: ToolRegistry,
  guard: PathGuard,
  workspaceRoot: string,
  log: pino.Logger
): void {
  const isWin = process.platform === "win32";
  // One shell for the whole workspace, reused across calls. Non-Windows
  // keeps the one-shot path: `bash -c` starts in single-digit milliseconds,
  // so there is nothing to win and a session to go wrong.
  const session = isWin ? new ShellSession(workspaceRoot, log) : null;

  registry.register(
    "run_terminal",
    async (input: RunTerminalInput, ctx): Promise<RunTerminalResult> => {
      assertCommandConfined(input.command, workspaceRoot);
      const cwd = input.cwd ? guard.toAbsolute(input.cwd) : workspaceRoot;
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const startedAt = Date.now();
      // The command itself, logged before it runs: a turn that hangs must
      // say what it hung on, not just that a terminal tool was running.
      log.info({ command: input.command, cwd }, "run_terminal ▶");
      // The same line opens the streamed output, so the process rail and
      // the transcript show the command above its own output.
      ctx.emitOutput(`$ ${input.command}\n`);

      const done = (result: RunTerminalResult): RunTerminalResult => {
        log.info(
          {
            command: input.command,
            cwd,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: Date.now() - startedAt,
            output: clip(result.output, MAX_LOGGED_OUTPUT),
          },
          "run_terminal ◀"
        );
        return result;
      };

      if (session && ShellSession.canServe(input.command)) {
        const run = await session.run(
          input.command,
          cwd,
          timeoutMs,
          ctx.signal,
          (chunk) => ctx.emitOutput(chunk)
        );
        const truncated = run.output.length > MAX_OUTPUT;
        return done({
          exitCode: run.exitCode,
          output: truncated ? run.output.slice(-MAX_OUTPUT) : run.output,
          truncated,
          timedOut: run.timedOut,
        });
      }

      const file = isWin ? "powershell.exe" : "bash";
      const args = isWin
        ? ["-NoProfile", "-NonInteractive", "-Command", input.command]
        : ["-c", input.command];

      const child = execa(file, args, {
        cwd,
        // Agent-run commands report through the process rail; a console
        // window stealing focus mid-task is never wanted.
        windowsHide: true,
        timeout: timeoutMs,
        cancelSignal: ctx.signal,
        forceKillAfterDelay: 1000,
        reject: false,
        all: true,
        env: { ...process.env, FORCE_COLOR: "0" },
      });
      const killTree = () => {
        if (process.platform === "win32" && child.pid) {
          spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          }).unref();
        } else {
          child.kill("SIGTERM");
        }
      };
      if (ctx.signal.aborted) killTree();
      else ctx.signal.addEventListener("abort", killTree, { once: true });

      let output = "";
      child.all?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        output += text;
        ctx.emitOutput(text);
      });

      try {
        const result = await child;
        const truncated = output.length > MAX_OUTPUT;
        return done({
          exitCode: result.exitCode ?? null,
          output: truncated ? output.slice(-MAX_OUTPUT) : output,
          truncated,
          timedOut: result.timedOut ?? false,
        });
      } finally {
        ctx.signal.removeEventListener("abort", killTree);
      }
    }
  );
}

function clip(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}
