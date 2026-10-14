/**
 * A terminal reopens where it was left: the manager follows the shell's
 * `cd`, and a terminal created with that directory starts in it.
 *
 * Needs no SQLite — the manager only touches terminal_history, stubbed here —
 * so unlike most smokes this one runs under plain Node.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "../src/storage/db.js";
import type { EventBus } from "../src/events/event-bus.js";
import { CwdScanner, sameDir } from "../src/terminal/shell-cwd.js";
import { TerminalManager } from "../src/terminal/terminal-manager.js";

const statement = { run: () => undefined, get: () => undefined };
const db = { prepare: () => statement } as unknown as Db;

const moves: Array<{ termId: string; cwd: string }> = [];
const output = new Map<string, string>();
const bus = {
  publish: (topic: string, payload: Record<string, string>) => {
    if (topic === "terminal.cwd") {
      moves.push({ termId: payload.termId!, cwd: payload.cwd! });
    }
    if (topic === "terminal.data") {
      const seen = output.get(payload.termId!) ?? "";
      output.set(payload.termId!, seen + payload.data!);
    }
  },
} as unknown as EventBus;

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// A report split across two PTY reads is still one report.
const scanner = new CwdScanner();
assert.equal(scanner.push("hello \x1b]633;P;Cwd=C:\\some"), null);
assert.equal(scanner.push("\\dir\x07PS> "), "C:\\some\\dir");
assert.equal(scanner.push("\x1b]7;file://host/tmp/a%20b\x1b\\"), "/tmp/a b");
assert.equal(scanner.push("plain output, no report"), null);

const root = mkdtempSync(path.join(os.tmpdir(), "atelier-cwd-smoke-"));
const sub = path.join(root, "sub dir");
const manager = new TerminalManager(db, bus, root);
try {
  const first = manager.create({ name: "Terminal 1" });
  assert.ok(sameDir(first.cwd, root), "starts in the workspace root");

  manager.write(first.id, "mkdir 'sub dir'; cd 'sub dir'\r");
  await until(
    () => moves.some((m) => m.termId === first.id && sameDir(m.cwd, sub)),
    "cd is reported"
  );
  const listed = manager.list().find((s) => s.id === first.id)!;
  assert.ok(sameDir(listed.cwd, sub), "terminal.list carries the new cwd");

  // The restart: a new terminal asked to open where the last one was left.
  const restored = manager.create({ name: "Terminal 1", cwd: listed.cwd });
  assert.ok(sameDir(restored.cwd, sub), "restored terminal starts in cwd");
  await until(
    () => (output.get(restored.id) ?? "").includes("sub dir>"),
    "restored prompt shows the directory"
  );

  // A directory that has since vanished must not fail the restore.
  const gone = manager.create({ cwd: path.join(root, "deleted") });
  assert.ok(sameDir(gone.cwd, root), "missing cwd falls back to the root");

  console.log("terminal-cwd-smoke: ok");
} finally {
  manager.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
