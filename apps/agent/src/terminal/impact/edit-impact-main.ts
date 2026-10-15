import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { analyzeEdit, formatImpact, type EditImpact } from "./edit-impact.js";

/**
 * The atelier-impact-check hook and command, bundled into the app as
 * `cli-skills/hooks/edit-impact.mjs` and run on the app's own runtime.
 *
 *   edit-impact.mjs claude|codex   PreToolUse / PostToolUse hook: event
 *                                  JSON on stdin; before an edit, what it
 *                                  can break; after it, what to re-check
 *   edit-impact.mjs --diff         after a fix: what the working-tree diff
 *                                  touches, as plain text
 *
 * The hook only ever adds context. It never denies or delays an edit: what
 * the edit may break is the agent's to check, and whether it may edit at
 * all stays with the user's own permission settings.
 */

/** A shell may hand over a stdin it never closes; the event is optional. */
const STDIN_WAIT_MS = 1500;

interface FileEdit {
  file: string;
  /**
   * The text to locate in the file: what an edit replaces before it runs,
   * what it wrote after. Null for a rewrite of the whole file.
   */
  edits: string[] | null;
}

type When = "before" | "after";

function readStdin(): Promise<string> {
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

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  return value && typeof value === "object" ? (value as Json) : {};
}

/** Claude Code's Edit, MultiEdit and Write. */
function claudeEdits(tool: string, input: Json, when: When): FileEdit[] {
  const file = typeof input.file_path === "string" ? input.file_path : null;
  if (!file) return [];
  const key = when === "after" ? "new_string" : "old_string";
  if (tool === "Write") return [{ file, edits: null }];
  if (tool === "Edit" && typeof input[key] === "string") {
    return [{ file, edits: [input[key] as string] }];
  }
  if (tool === "MultiEdit" && Array.isArray(input.edits)) {
    const edits = input.edits
      .map((edit) => asObject(edit)[key])
      .filter((text): text is string => typeof text === "string");
    return [{ file, edits }];
  }
  return [];
}

/** Every string inside a value: Codex nests its patch differently by tool. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

/**
 * The files an apply_patch changes, with the lines it removes from each
 * (before) or adds to each (after). A deleted file is gone after the patch.
 */
export function patchEdits(patch: string, when: When = "before"): FileEdit[] {
  const marker = when === "after" ? "+" : "-";
  const edits: FileEdit[] = [];
  let current: FileEdit | null = null;
  for (const line of patch.split(/\r?\n/)) {
    const header = line.match(/^\*\*\* (Update|Delete|Add) File: (.+)$/);
    if (header) {
      current = null;
      if (header[1] === "Add" && when === "before") continue;
      if (header[1] === "Delete" && when === "after") continue;
      current = {
        file: header[2]!.trim(),
        edits: header[1] === "Update" ? [] : null,
      };
      edits.push(current);
      continue;
    }
    if (current?.edits && line.startsWith(marker) && line.slice(1).trim()) {
      current.edits.push(line.slice(1));
    }
  }
  return edits;
}

function codexEdits(input: unknown, when: When): FileEdit[] {
  return strings(input)
    .filter((text) => text.includes("*** Begin Patch"))
    .flatMap((patch) => patchEdits(patch, when));
}

/** JSON with every non-ASCII character escaped (Windows PowerShell safe). */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u0080-￿]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

function record(
  cwd: string,
  provider: string,
  when: When,
  impact: EditImpact
): void {
  try {
    const dir = path.join(cwd, ".atelier");
    fs.mkdirSync(dir, { recursive: true });
    const entry = {
      at: new Date().toISOString(),
      provider,
      when,
      file: impact.file,
      symbols: impact.symbols.map((symbol) => symbol.name),
      sites: impact.sites.length,
      tests: impact.tests,
    };
    fs.appendFileSync(path.join(dir, "impact.log"), `${asciiJson(entry)}\n`);
  } catch {
    // The log is a record, not a gate.
  }
}

async function hook(provider: string): Promise<void> {
  const event = (() => {
    try {
      return asObject(JSON.parse(stdinText.replace(/^﻿/, "")));
    } catch {
      return {};
    }
  })();
  const cwd = typeof event.cwd === "string" ? event.cwd : process.cwd();
  const tool = typeof event.tool_name === "string" ? event.tool_name : "";
  const eventName =
    event.hook_event_name === "PostToolUse" ? "PostToolUse" : "PreToolUse";
  const when: When = eventName === "PostToolUse" ? "after" : "before";
  const edits =
    provider === "codex"
      ? codexEdits(event.tool_input, when)
      : claudeEdits(tool, asObject(event.tool_input), when);
  const reports: string[] = [];
  for (const edit of edits) {
    const impact = await analyzeEdit({ cwd, file: edit.file, edits: edit.edits });
    if (!impact) continue;
    record(cwd, provider, when, impact);
    reports.push(formatImpact(impact, when));
  }
  if (reports.length === 0) return;
  process.stdout.write(
    asciiJson({
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: reports.join("\n\n"),
      },
    })
  );
}

/** Changed rows (0-based, inclusive) per file in the working-tree diff. */
function diffRanges(cwd: string): Map<string, Array<[number, number]>> {
  const ranges = new Map<string, Array<[number, number]>>();
  let diff = "";
  try {
    diff = execFileSync(
      "git",
      ["diff", "HEAD", "--unified=0", "--no-color", "--no-ext-diff"],
      { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
  } catch {
    return ranges;
  }
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  }).trim();
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    const target = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
    if (target) {
      file = target[1] === "/dev/null" ? null : path.join(root, target[1]!);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk && file) {
      const start = Math.max(0, Number(hunk[1]) - 1);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const list = ranges.get(file) ?? [];
      list.push([start, start + Math.max(0, count - 1)]);
      ranges.set(file, list);
    }
  }
  return ranges;
}

async function diffCheck(): Promise<void> {
  const cwd = process.cwd();
  const reports: string[] = [];
  for (const [file, ranges] of diffRanges(cwd)) {
    const impact = await analyzeEdit({ cwd, file, edits: [], ranges });
    if (impact) reports.push(formatImpact(impact, "after"));
  }
  process.stdout.write(
    reports.length > 0
      ? `${reports.join("\n\n")}\n`
      : "No changed TS/JS function in the working tree.\n"
  );
}

const mode = process.argv[2] ?? "claude";
let stdinText = "";
if (mode === "--diff") {
  await diffCheck();
} else {
  stdinText = await readStdin();
  await hook(mode);
}
