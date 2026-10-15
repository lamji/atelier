import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { watchTurnMarkers } from "./turn-markers.js";

const hookScript = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")),
  "../../cli-hooks/turn-end.mjs"
);

/** Runs the Stop hook as a CLI would: the event on stdin, env from the pty. */
function runHook(env: Record<string, string>, event: object) {
  return new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, [hookScript, "codex"], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(event));
  });
}

function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > ms) return reject(new Error("timed out"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test("the Stop hook marks the terminal and the watcher reports it once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-turns-"));
  // A marker from before the agent started is not a new turn.
  fs.writeFileSync(path.join(dir, "term_old"), JSON.stringify({ at: 1 }));
  const ended: string[] = [];
  const stop = watchTurnMarkers(dir, (termId) => ended.push(termId));
  try {
    const result = await runHook(
      { ATELIER_TURN_DIR: dir, ATELIER_TERM_ID: "term_abc" },
      { hook_event_name: "Stop", session_id: "s1" }
    );
    // Codex refuses plain text from a Stop hook that exits 0.
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {});
    await waitFor(() => ended.length > 0);
    // fs.watch reports one write several times; give it room to.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(ended, ["term_abc"]);
    const marker = JSON.parse(
      fs.readFileSync(path.join(dir, "term_abc"), "utf8")
    );
    assert.equal(marker.event, "Stop");
    assert.equal(marker.cli, "codex");
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("without a terminal id the hook writes nothing and still lets the stop go", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-turns-"));
  try {
    const env = { ATELIER_TURN_DIR: dir, ATELIER_TERM_ID: "../escape" };
    const result = await runHook(env, {});
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "{}");
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
