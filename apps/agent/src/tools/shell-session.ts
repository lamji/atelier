import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type pino from "pino";

/**
 * A long-lived shell the agent's commands are typed into, instead of one
 * fresh process per call.
 *
 * Spawning `powershell.exe` costs half a second to a second on Windows
 * before the command itself starts, and an agent turn issues dozens of
 * commands — that startup was the single largest slice of a slow turn.
 * One shell stays open per workspace and every command is written to its
 * stdin, followed by a sentinel line that carries the exit code back.
 *
 * Only single-line commands are served here. A multi-line command can leave
 * the shell sitting at a continuation prompt, which would swallow the
 * sentinel and hang the session, so the caller runs those one-shot.
 */
export class ShellSession {
  private child: ChildProcess | null = null;
  /** Commands are serialized: one shell, one command at a time. */
  private chain: Promise<unknown> = Promise.resolve();
  private collect: ((text: string) => void) | null = null;

  constructor(
    private cwd: string,
    private log: pino.Logger
  ) {}

  /** True when the command can be served by the persistent shell. */
  static canServe(command: string): boolean {
    return !command.includes("\n") && !command.includes("\r");
  }

  private ensure(): ChildProcess {
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return this.child;
    }
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", "-"],
      { cwd: this.cwd, windowsHide: true, env: { ...process.env, FORCE_COLOR: "0" } }
    );
    const onData = (chunk: Buffer) => this.collect?.(chunk.toString("utf8"));
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      this.log.debug({ code }, "shell session exited");
      if (this.child === child) this.child = null;
    });
    this.child = child;
    return child;
  }

  /** Kills the shell; the next command starts a fresh one. */
  dispose(): void {
    const child = this.child;
    this.child = null;
    if (!child?.pid) return;
    spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    }).unref();
  }

  /**
   * Runs one command and resolves with its combined output and exit code.
   * `onChunk` receives output as it arrives, sentinel line excluded.
   */
  run(
    command: string,
    cwd: string,
    timeoutMs: number,
    signal: AbortSignal,
    onChunk: (text: string) => void
  ): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
    const task = this.chain.then(() =>
      this.exec(command, cwd, timeoutMs, signal, onChunk)
    );
    // The chain must survive a failed command, or every later call rejects.
    this.chain = task.catch(() => undefined);
    return task;
  }

  private exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    signal: AbortSignal,
    onChunk: (text: string) => void
  ): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
    const child = this.ensure();
    const sentinel = `__ATELIER_DONE_${randomUUID().replace(/-/g, "")}__`;
    const marker = new RegExp(`${sentinel} (-?\\d+)`);

    return new Promise((resolve) => {
      let output = "";
      let pending = "";
      let settled = false;

      const finish = (
        exitCode: number | null,
        timedOut: boolean,
        killShell: boolean
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.collect = null;
        if (killShell) this.dispose();
        resolve({ exitCode, output, timedOut });
      };

      // Output arrives in arbitrary chunks, so the sentinel can straddle
      // two of them; hold back a partial trailing line until it completes.
      this.collect = (text: string) => {
        pending += text;
        const hit = marker.exec(pending);
        if (hit) {
          const before = pending.slice(0, hit.index);
          if (before) {
            output += before;
            onChunk(before);
          }
          finish(Number(hit[1]), false, false);
          return;
        }
        const cut = pending.lastIndexOf("\n");
        if (cut === -1) return;
        const ready = pending.slice(0, cut + 1);
        pending = pending.slice(cut + 1);
        output += ready;
        onChunk(ready);
      };

      const timer = setTimeout(() => finish(null, true, true), timeoutMs);
      const onAbort = () => finish(null, false, true);
      if (signal.aborted) return finish(null, false, true);
      signal.addEventListener("abort", onAbort, { once: true });

      // $LASTEXITCODE only speaks for native executables; a failed cmdlet
      // reports through $? instead, so both are folded into one status.
      const script =
        `Set-Location -LiteralPath ${quote(cwd)}\n` +
        `$global:LASTEXITCODE = 0\n` +
        `try { ${command} } catch { Write-Output $_.Exception.Message; ` +
        `$global:LASTEXITCODE = 1 }\n` +
        `if (-not $? -and $LASTEXITCODE -eq 0) { $global:LASTEXITCODE = 1 }\n` +
        `Write-Output "${sentinel} $LASTEXITCODE"\n`;
      child.stdin?.write(script);
    });
  }
}

/** Single-quotes a path for PowerShell, doubling any embedded quote. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
