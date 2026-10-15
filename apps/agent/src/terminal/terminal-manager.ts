import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as pty from "@lydell/node-pty";
import type { IPty } from "@lydell/node-pty";
import type { TerminalSession } from "@atelier/protocol";
import { newId } from "@atelier/shared";
import type { Db } from "../storage/db.js";
import type { EventBus } from "../events/event-bus.js";
import {
  CwdScanner,
  isUsableDir,
  probeProcessCwd,
  sameDir,
  shellLaunch,
} from "./shell-cwd.js";
import { watchTurnMarkers } from "./turn-markers.js";

/**
 * Output arriving closer together than this is coalesced into one frame. A
 * terminal that has been quiet for longer is flushed straight away instead:
 * that chunk is a keystroke's echo, and a timer in front of it is latency
 * paid on every key (Windows rounds a 16 ms timer up to ~31 ms).
 */
const FLUSH_MS = 16;
const FLUSH_BYTES = 8 * 1024;
const HISTORY_CAP = 200_000;
/** History is kept as chunks; past this many they are folded into one. */
const HISTORY_MAX_CHUNKS = 512;
const HISTORY_SAVE_MS = 5000;
/** Output has to go quiet this long before a POSIX shell's cwd is re-read. */
const CWD_PROBE_MS = 400;
/** A warm shell nobody claimed is ended after this long. */
const WARM_SHELL_TTL_MS = 60_000;

interface ManagedTerminal {
  session: TerminalSession;
  pty: IPty;
  buffer: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  flushSoon: ReturnType<typeof setImmediate> | null;
  lastFlushAt: number;
  /** Scrollback as it arrived; joined only when somebody reads it. */
  history: string[];
  historyLength: number;
  historyDirty: boolean;
  /** False once the user explicitly closes this terminal. */
  persistOnExit: boolean;
  cwdScanner: CwdScanner;
  cwdProbeTimer: ReturnType<typeof setTimeout> | null;
  /**
   * False for the warm shell nobody has asked for yet: it is not listed,
   * publishes nothing, and only collects its own startup output.
   */
  adopted: boolean;
}

interface CreateOptions {
  cwd?: string;
  name?: string;
  cols?: number;
  rows?: number;
}

/**
 * Owns all PTY sessions (ConPTY on Windows). Output is coalesced
 * (16 ms / 8 KB) into terminal.data events, except the first chunk after a
 * quiet spell, which goes out at once; history survives UI reloads via
 * SQLite and is capped per session.
 */
export class TerminalManager {
  private terminals = new Map<string, ManagedTerminal>();
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  /** A shell started ahead of the create that will claim it. */
  private warm: ManagedTerminal | null = null;
  private warmTimer: ReturnType<typeof setTimeout> | null = null;
  private stopTurnWatch: (() => void) | null = null;

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

  create(opts: CreateOptions): TerminalSession {
    // A restored terminal asks for the directory it was left in, and that
    // directory may have been deleted or renamed since.
    const cwd = isUsableDir(opts.cwd) ? opts.cwd : this.defaultCwd;
    const managed =
      this.takeWarm(cwd) ?? this.launch(cwd, opts.cols ?? 80, opts.rows ?? 24);
    return this.adopt(managed, opts);
  }

  /**
   * Start a shell now for the create that is about to come.
   *
   * Spawning a pty is synchronous and, on Windows, slow (0.2-0.7 s measured
   * here), and PowerShell then takes about as long again to load its profile
   * and reach a prompt. Paid at create time, that is all dead air between
   * choosing a CLI and seeing it start. Paid here — when the picker opens —
   * the shell is already waiting when the choice is made.
   */
  prewarm(): void {
    if (this.shuttingDown || this.warm) return;
    try {
      this.warm = this.launch(this.defaultCwd, 80, 24);
    } catch {
      // No shell to warm; the real create will report the failure.
      return;
    }
    this.warmTimer = setTimeout(() => this.dropWarm(), WARM_SHELL_TTL_MS);
  }

  /** The warm shell, if there is one and it sits in the wanted directory. */
  private takeWarm(cwd: string): ManagedTerminal | null {
    const warm = this.warm;
    if (!warm || !warm.session.alive) return null;
    if (!sameDir(cwd, warm.session.cwd)) return null;
    this.forgetWarm();
    return warm;
  }

  private forgetWarm(): void {
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = null;
    this.warm = null;
  }

  private dropWarm(): void {
    const warm = this.warm;
    this.forgetWarm();
    if (!warm) return;
    try {
      killTree(warm.pty);
    } catch {
      // already dead
    }
  }

  /**
   * Report CLI turns that end in this workspace's terminals, from the
   * markers the CLIs' turn-end hook writes into `dir`. The host is shared
   * by every open workspace, so a marker for another one's terminal is
   * left alone.
   */
  watchTurnEnds(dir: string): void {
    this.stopTurnWatch?.();
    this.stopTurnWatch = watchTurnMarkers(dir, (termId) => {
      if (!this.terminals.has(termId)) return;
      this.bus.publish("terminal.turn.ended", { termId });
    });
  }

  /** Starts a shell and wires its output; nothing is announced yet. */
  private launch(cwd: string, cols: number, rows: number): ManagedTerminal {
    const shell = shellLaunch();
    const id = newId("term");
    const proc = pty.spawn(shell.file, shell.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      // A CLI started in this shell hands it to its turn-end hook, which is
      // how Atelier learns whose turn ended.
      env: { ...process.env, ATELIER_TERM_ID: id } as Record<string, string>,
    });

    const session: TerminalSession = {
      id,
      name: "",
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
      flushSoon: null,
      lastFlushAt: 0,
      history: [],
      historyLength: 0,
      historyDirty: false,
      persistOnExit: true,
      cwdScanner: new CwdScanner(),
      cwdProbeTimer: null,
      adopted: false,
    };

    proc.onData((data) => this.onData(managed, data));
    proc.onExit(({ exitCode }) => {
      this.flush(managed);
      if (managed.cwdProbeTimer) clearTimeout(managed.cwdProbeTimer);
      session.alive = false;
      if (!managed.adopted) {
        if (this.warm === managed) this.forgetWarm();
        return;
      }
      if (this.shuttingDown) return;
      this.bus.publish("terminal.exit", { termId: session.id, exitCode });
      this.bus.publish("terminal.session.closed", { termId: session.id });
      if (managed.persistOnExit) this.saveHistoryRow(managed);
      else this.deleteHistoryRow(session.id);
      this.terminals.delete(session.id);
    });
    return managed;
  }

  /** Lists a launched shell as a session and announces it. */
  private adopt(managed: ManagedTerminal, opts: CreateOptions): TerminalSession {
    const { session } = managed;
    session.name = opts.name ?? `Terminal ${this.terminals.size + 1}`;
    session.createdAt = Date.now();
    const cols = opts.cols ?? session.cols;
    const rows = opts.rows ?? session.rows;
    if (cols !== session.cols || rows !== session.rows) {
      managed.pty.resize(Math.max(2, cols), Math.max(2, rows));
      session.cols = cols;
      session.rows = rows;
    }
    // Whatever a warm shell printed while it waited is in its history, which
    // is what the UI replays on mount — sending it again would double it.
    this.cancelFlush(managed);
    managed.buffer = "";
    managed.adopted = true;
    this.terminals.set(session.id, managed);

    this.bus.publish("terminal.session.created", {
      termId: session.id,
      name: session.name,
    });
    // Persist the identity immediately. A newly opened CLI session must still
    // be recoverable if Electron closes before the first history flush.
    this.saveHistoryRow(managed);
    return session;
  }

  private onData(managed: ManagedTerminal, data: string): void {
    managed.buffer += data;
    this.remember(managed, data);
    this.trackCwd(managed, data);
    if (managed.buffer.length >= FLUSH_BYTES) {
      this.flush(managed);
      return;
    }
    if (managed.flushTimer || managed.flushSoon) return;
    const quietFor = Date.now() - managed.lastFlushAt;
    if (quietFor >= FLUSH_MS) {
      // setImmediate, not a direct flush: it still gathers every chunk the
      // pty delivered in this turn of the loop, and costs no timer tick.
      managed.flushSoon = setImmediate(() => this.flush(managed));
      return;
    }
    managed.flushTimer = setTimeout(
      () => this.flush(managed),
      FLUSH_MS - quietFor
    );
  }

  /**
   * Appends to the scrollback without copying it. Concatenating and slicing
   * a 200 KB string per chunk is megabytes a second of garbage while a TUI
   * redraws, on the thread that also carries the keystrokes.
   */
  private remember(managed: ManagedTerminal, data: string): void {
    managed.history.push(data);
    managed.historyLength += data.length;
    managed.historyDirty = true;
    while (
      managed.history.length > 1 &&
      managed.historyLength - managed.history[0]!.length >= HISTORY_CAP
    ) {
      managed.historyLength -= managed.history.shift()!.length;
    }
    if (managed.history.length > HISTORY_MAX_CHUNKS) this.historyText(managed);
  }

  /** The scrollback as one capped string, folded back into a single chunk. */
  private historyText(managed: ManagedTerminal): string {
    const joined = managed.history.join("");
    const text =
      joined.length > HISTORY_CAP ? joined.slice(-HISTORY_CAP) : joined;
    managed.history = text ? [text] : [];
    managed.historyLength = text.length;
    return text;
  }

  /**
   * Follow the shell as the user moves around, so the terminal can be
   * reopened where it was left. See shell-cwd.ts for the two mechanisms.
   */
  private trackCwd(managed: ManagedTerminal, data: string): void {
    const reported = managed.cwdScanner.push(data);
    if (reported) this.noteCwd(managed, reported);
    if (process.platform === "win32") return;
    if (managed.cwdProbeTimer) clearTimeout(managed.cwdProbeTimer);
    managed.cwdProbeTimer = setTimeout(() => {
      managed.cwdProbeTimer = null;
      void probeProcessCwd(managed.pty.pid).then((cwd) => {
        if (cwd && managed.session.alive) this.noteCwd(managed, cwd);
      });
    }, CWD_PROBE_MS);
  }

  private noteCwd(managed: ManagedTerminal, cwd: string): void {
    if (sameDir(cwd, managed.session.cwd)) return;
    managed.session.cwd = cwd;
    if (!managed.adopted) return;
    this.bus.publish("terminal.cwd", { termId: managed.session.id, cwd });
  }

  private cancelFlush(managed: ManagedTerminal): void {
    if (managed.flushTimer) clearTimeout(managed.flushTimer);
    if (managed.flushSoon) clearImmediate(managed.flushSoon);
    managed.flushTimer = null;
    managed.flushSoon = null;
  }

  private flush(managed: ManagedTerminal): void {
    this.cancelFlush(managed);
    if (!managed.buffer) return;
    const data = managed.buffer;
    managed.buffer = "";
    managed.lastFlushAt = Date.now();
    if (!managed.adopted) return;
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
    if (managed) return this.historyText(managed);
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
        this.historyText(managed),
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
    this.stopTurnWatch?.();
    this.dropWarm();
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
