import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as pty from "@lydell/node-pty";
import type { IPty } from "@lydell/node-pty";
import type { TerminalSession } from "@atelier/protocol";
import { newId } from "@atelier/shared";
import type { Db } from "../storage/db.js";
import type { EventBus } from "../events/event-bus.js";

const FLUSH_MS = 16;
const FLUSH_BYTES = 8 * 1024;
const HISTORY_CAP = 200_000;
const HISTORY_SAVE_MS = 1000;

interface ManagedTerminal {
  session: TerminalSession;
  pty: IPty;
  buffer: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  history: string;
  historyDirty: boolean;
  /** False once the user explicitly closes this terminal. */
  persistOnExit: boolean;
}

/**
 * Owns all PTY sessions (ConPTY on Windows). Output is coalesced
 * (16 ms / 8 KB) into terminal.data events; history survives UI reloads
 * via SQLite and is capped per session.
 */
export class TerminalManager {
  private terminals = new Map<string, ManagedTerminal>();
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

  constructor(
    private db: Db,
    private bus: EventBus,
    private defaultCwd: string
  ) {
    this.saveTimer = setInterval(() => this.saveDirtyHistory(), HISTORY_SAVE_MS);
    // PTYs cannot survive the agent process. Provider conversations already
    // live in Codex/Claude history and are resumed by exact id from CLI mode;
    // restoring saved PTYs with a bare `resume` command only opens another
    // session picker and duplicates meaningless "Codex N" rows.
    this.db.prepare("DELETE FROM terminal_history").run();
  }

  create(opts: {
    cwd?: string;
    name?: string;
    cols?: number;
    rows?: number;
  }): TerminalSession {
    return this.spawn(opts);
  }

  private spawn(
    opts: {
      cwd?: string;
      name?: string;
      cols?: number;
      rows?: number;
    }
  ): TerminalSession {
    const id = newId("term");
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 24;
    const cwd = opts.cwd ?? this.defaultCwd;
    const shell =
      process.platform === "win32"
        ? "powershell.exe"
        : (process.env.SHELL ?? "bash");

    const proc = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env } as Record<string, string>,
    });

    const session: TerminalSession = {
      id,
      name: opts.name ?? `Terminal ${this.terminals.size + 1}`,
      cwd,
      cols,
      rows,
      createdAt: Date.now(),
      alive: true,
    };
    const managed: ManagedTerminal = {
      session,
      pty: proc,
      buffer: "",
      flushTimer: null,
      history: "",
      historyDirty: false,
      persistOnExit: true,
    };
    this.terminals.set(id, managed);

    proc.onData((data) => this.onData(managed, data));
    proc.onExit(({ exitCode }) => {
      this.flush(managed);
      session.alive = false;
      if (this.shuttingDown) return;
      this.bus.publish("terminal.exit", { termId: id, exitCode });
      this.bus.publish("terminal.session.closed", { termId: id });
      if (managed.persistOnExit) this.saveHistoryRow(managed);
      else this.deleteHistoryRow(id);
      this.terminals.delete(id);
    });

    this.bus.publish("terminal.session.created", {
      termId: id,
      name: session.name,
    });
    // Persist the identity immediately. A newly opened CLI session must still
    // be recoverable if Electron closes before the first history flush.
    this.saveHistoryRow(managed);
    return session;
  }

  private onData(managed: ManagedTerminal, data: string): void {
    managed.buffer += data;
    managed.history =
      managed.history.length + data.length > HISTORY_CAP
        ? (managed.history + data).slice(-HISTORY_CAP)
        : managed.history + data;
    managed.historyDirty = true;
    if (managed.buffer.length >= FLUSH_BYTES) {
      this.flush(managed);
      return;
    }
    managed.flushTimer ??= setTimeout(() => this.flush(managed), FLUSH_MS);
  }

  private flush(managed: ManagedTerminal): void {
    if (managed.flushTimer) {
      clearTimeout(managed.flushTimer);
      managed.flushTimer = null;
    }
    if (!managed.buffer) return;
    const data = managed.buffer;
    managed.buffer = "";
    this.bus.publish("terminal.data", { termId: managed.session.id, data });
  }

  write(termId: string, data: string): void {
    this.get(termId).pty.write(data);
  }

  resize(termId: string, cols: number, rows: number): void {
    const managed = this.get(termId);
    managed.pty.resize(Math.max(2, cols), Math.max(2, rows));
    managed.session.cols = cols;
    managed.session.rows = rows;
  }

  kill(termId: string): void {
    const managed = this.get(termId);
    managed.persistOnExit = false;
    this.deleteHistoryRow(termId);
    killTree(managed.pty);
  }

  /**
   * The second Ctrl+C: stop the running job, keep the prompt.
   *
   * A plain ^C is not enough on Windows. `npm run dev` becomes
   * npm.cmd -> concurrently -> tsx/vite, npm.cmd answers ^C with its own
   * "Terminate batch job (Y/N)?" prompt, and the grandchildren belong to no
   * job object — so the shell returns to a prompt while vite still holds
   * port 5173. Killing every descendant of the shell (but not the shell)
   * is what actually frees the port and leaves the terminal usable.
   */
  async interrupt(termId: string): Promise<number> {
    const managed = this.get(termId);
    const descendants = await descendantPids(managed.pty.pid);
    let killed = 0;
    for (const pid of descendants) {
      if (killPid(pid)) killed += 1;
    }
    return killed;
  }

  list(): TerminalSession[] {
    return [...this.terminals.values()].map((t) => t.session);
  }

  getHistory(termId: string): string {
    const managed = this.terminals.get(termId);
    if (managed) return managed.history;
    const row = this.db
      .prepare("SELECT data FROM terminal_history WHERE term_id = ?")
      .get(termId) as { data: string } | undefined;
    return row?.data ?? "";
  }

  private get(termId: string): ManagedTerminal {
    const managed = this.terminals.get(termId);
    if (!managed) throw new Error(`Unknown terminal: ${termId}`);
    return managed;
  }

  private saveDirtyHistory(): void {
    for (const managed of this.terminals.values()) {
      if (managed.persistOnExit && managed.historyDirty) {
        this.saveHistoryRow(managed);
      }
    }
  }

  private saveHistoryRow(managed: ManagedTerminal): void {
    if (!managed.persistOnExit) return;
    managed.historyDirty = false;
    this.db
      .prepare(
        "INSERT INTO terminal_history(term_id, name, cwd, data, updated_at) " +
          "VALUES(?, ?, ?, ?, ?) ON CONFLICT(term_id) DO UPDATE SET " +
          "data = excluded.data, updated_at = excluded.updated_at"
      )
      .run(
        managed.session.id,
        managed.session.name,
        managed.session.cwd,
        managed.history,
        Date.now()
      );
  }

  private deleteHistoryRow(termId: string): void {
    this.db.prepare("DELETE FROM terminal_history WHERE term_id = ?").run(termId);
  }

  shutdown(): void {
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.saveDirtyHistory();
    this.shuttingDown = true;
    for (const managed of this.terminals.values()) {
      try {
        killTree(managed.pty);
      } catch {
        // already dead
      }
    }
    this.terminals.clear();
  }
}

/**
 * End the shell AND everything it started.
 *
 * `pty.kill()` alone terminates the shell it spawned and nothing below it.
 * On Windows that is not a detail: a `npm run dev` expands into npm ->
 * concurrently -> tsx/vite, and those grandchildren are in no job object, so
 * killing the shell orphans them still holding their ports — which is what
 * turns the next run into "port 5173 is already in use". taskkill /T walks
 * the child tree the way the OS records it.
 *
 * POSIX gets the same guarantee for free: node-pty signals the pty's process
 * group, which is the whole foreground job.
 */
const execFileAsync = promisify(execFile);

/** Every live process as `pid ppid`, which is all a tree walk needs. */
async function processTable(): Promise<Map<number, number[]>> {
  const command =
    process.platform === "win32"
      ? execFileAsync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process | " +
              'ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
          ],
          { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
        )
      : execFileAsync("ps", ["-A", "-o", "pid=,ppid="], {
          maxBuffer: 8 * 1024 * 1024,
        });

  const children = new Map<number, number[]>();
  const { stdout } = await command;
  for (const line of stdout.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2) continue;
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  return children;
}

/**
 * Descendants of `root`, deepest first and excluding `root` itself. Killing
 * in that order stops a supervisor (npm, concurrently) from noticing a dead
 * child and reacting before it is taken down too.
 */
async function descendantPids(root: number): Promise<number[]> {
  const children = await processTable();
  const ordered: number[] = [];
  const walk = (pid: number, depth: number): void => {
    // A malformed table could in principle cycle; depth caps the recursion.
    if (depth > 32) return;
    for (const child of children.get(pid) ?? []) {
      walk(child, depth + 1);
      ordered.push(child);
    }
  };
  walk(root, 0);
  return ordered;
}

/** SIGKILL maps to TerminateProcess on Windows, so this is cross-platform. */
function killPid(pid: number): boolean {
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    // Already gone, or not ours to kill.
    return false;
  }
}

function killTree(proc: IPty): void {
  if (process.platform !== "win32") {
    proc.kill();
    return;
  }
  // /F because a dev server mid-request will not leave on a polite ask, and
  // this path is only reached when the user already asked for it to stop.
  execFile("taskkill", ["/pid", String(proc.pid), "/T", "/F"], (error) => {
    // Racing the process's own exit is normal (it may already be gone), so a
    // failure here is not worth surfacing — but the shell must still go.
    if (error) {
      try {
        proc.kill();
      } catch {
        // already dead
      }
    }
  });
}
