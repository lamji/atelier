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
}

/**
 * Owns all PTY sessions (ConPTY on Windows). Output is coalesced
 * (16 ms / 8 KB) into terminal.data events; history survives UI reloads
 * via SQLite and is capped per session.
 */
export class TerminalManager {
  private terminals = new Map<string, ManagedTerminal>();
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: Db,
    private bus: EventBus,
    private defaultCwd: string
  ) {
    this.saveTimer = setInterval(() => this.saveDirtyHistory(), HISTORY_SAVE_MS);
    this.db.prepare("DELETE FROM terminal_history").run();
  }

  create(opts: {
    cwd?: string;
    name?: string;
    cols?: number;
    rows?: number;
  }): TerminalSession {
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
    };
    this.terminals.set(id, managed);

    proc.onData((data) => this.onData(managed, data));
    proc.onExit(({ exitCode }) => {
      this.flush(managed);
      session.alive = false;
      this.bus.publish("terminal.exit", { termId: id, exitCode });
      this.bus.publish("terminal.session.closed", { termId: id });
      this.saveHistoryRow(managed);
      this.terminals.delete(id);
    });

    this.bus.publish("terminal.session.created", {
      termId: id,
      name: session.name,
    });
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
    this.get(termId).pty.kill();
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
      if (managed.historyDirty) this.saveHistoryRow(managed);
    }
  }

  private saveHistoryRow(managed: ManagedTerminal): void {
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

  shutdown(): void {
    if (this.saveTimer) clearInterval(this.saveTimer);
    for (const managed of this.terminals.values()) {
      try {
        managed.pty.kill();
      } catch {
        // already dead
      }
    }
    this.terminals.clear();
  }
}
