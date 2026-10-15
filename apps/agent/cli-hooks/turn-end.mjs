// Stop hook for the Claude and Codex CLIs started from Atelier.
//
//   <runtime> turn-end.mjs <claude|codex>     (JSON event on stdin)
//
// Both CLIs run it when a turn ends: Claude when the main agent finishes
// responding, Codex when the turn stops. It tells Atelier which terminal's
// turn ended by writing a marker named after the terminal into
// ATELIER_TURN_DIR, which the agent watches. That is what keeps the
// session's reports current: the reports are checked at turn end, and the
// terminal's screen alone cannot say reliably when a turn has ended.
//
// It never blocks the stop. Codex requires JSON on stdout when the hook
// exits 0, so it prints an empty object, which Claude accepts too.
import fs from "node:fs";
import path from "node:path";

/** A shell may hand over a stdin it never closes; the event is optional. */
const STDIN_WAIT_MS = 1500;

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let text = "";
    const done = () => {
      clearTimeout(timer);
      process.stdin.pause();
      resolve(text);
    };
    const timer = setTimeout(done, STDIN_WAIT_MS);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

function parseEvent(text) {
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return {};
  }
}

/** Only an id Atelier minted: it becomes a file name. */
const TERM_ID = /^[A-Za-z0-9_-]{1,80}$/;

async function main() {
  const event = parseEvent(await readStdin());
  const dir = process.env.ATELIER_TURN_DIR;
  const termId = process.env.ATELIER_TERM_ID;
  if (dir && termId && TERM_ID.test(termId)) {
    const marker = {
      at: Date.now(),
      cli: process.argv[2] ?? "",
      event: event.hook_event_name ?? "Stop",
      session: event.session_id ?? null,
    };
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, termId), JSON.stringify(marker));
    } catch {
      // Nothing to report to; the stop goes ahead regardless.
    }
  }
  process.stdout.write("{}");
}

void main().finally(() => process.exit(0));
