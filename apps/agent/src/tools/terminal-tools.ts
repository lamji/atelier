import path from "node:path";
import { execa } from "execa";
import type { PathGuard } from "../workspace/path-guard.js";
import type { ToolRegistry } from "./registry.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 60_000;

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
  workspaceRoot: string
): void {
  registry.register(
    "run_terminal",
    async (input: RunTerminalInput, ctx): Promise<RunTerminalResult> => {
      assertCommandConfined(input.command, workspaceRoot);
      const cwd = input.cwd ? guard.toAbsolute(input.cwd) : workspaceRoot;
      const isWin = process.platform === "win32";
      const file = isWin ? "powershell.exe" : "bash";
      const args = isWin
        ? ["-NoProfile", "-NonInteractive", "-Command", input.command]
        : ["-c", input.command];

      const child = execa(file, args, {
        cwd,
        timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        cancelSignal: ctx.signal,
        reject: false,
        all: true,
        env: { ...process.env, FORCE_COLOR: "0" },
      });

      let output = "";
      child.all?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        output += text;
        ctx.emitOutput(text);
      });

      const result = await child;
      const truncated = output.length > MAX_OUTPUT;
      return {
        exitCode: result.exitCode ?? null,
        output: truncated ? output.slice(-MAX_OUTPUT) : output,
        truncated,
        timedOut: result.timedOut ?? false,
      };
    }
  );
}
