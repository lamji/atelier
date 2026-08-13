import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type { CliHistoryEntry } from "@atelier/protocol";

/**
 * The past sessions of the provider CLIs, read from the transcripts they
 * already write.
 *
 * CLI mode runs somebody else's program in a pty, so Atelier only knows the
 * sessions it started itself — while the CLI's own `resume` picker knows all
 * of them, including the ones started from a plain terminal. That list is a
 * directory of JSONL files on disk; this reads it, so the session list shows
 * what the picker shows instead of a subset of it.
 *
 * Read-only and forgiving throughout: a missing directory, a half-written
 * last line, or a transcript format that has moved on drops that one row
 * rather than failing the call.
 */

/** Newest transcripts whose head is parsed, per provider. */
const MAX_FILES_PARSED = 250;
/** Ceiling on the directory walk, so a huge history cannot stall the call. */
const MAX_FILES_WALKED = 1500;
/**
 * Bytes read from the front of each transcript. Enough for the session
 * header plus the environment preamble plus the first real prompt, which is
 * all a row needs — the rest of the file can be megabytes.
 */
const HEAD_BYTES = 64 * 1024;
/**
 * Codex can put large injected instruction records before the first prompt.
 * Scan farther for that prompt, but keep the work bounded per transcript.
 */
const CODEX_HEAD_BYTES = 512 * 1024;
/** Row labels are truncated in the UI; this only stops absurd strings. */
const MAX_TITLE_CHARS = 200;

interface WalkedFile {
  file: string;
  mtime: number;
}

/**
 * JSONL files under `root`, newest first.
 *
 * Directories are visited in reverse name order, which for Codex's
 * `YYYY/MM/DD` layout means the newest days are walked first — so the cap
 * cuts off ancient sessions rather than recent ones.
 */
async function walkJsonl(root: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < MAX_FILES_WALKED) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const dirs: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const stat = await fs.stat(full);
          out.push({ file: full, mtime: stat.mtimeMs });
        } catch {
          // vanished mid-walk — the CLI rotates its own files
        }
      }
      if (out.length >= MAX_FILES_WALKED) break;
    }
    // Ascending push, LIFO pop: the newest-named directory comes out first.
    dirs.sort();
    stack.push(...dirs);
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, MAX_FILES_PARSED);
}

/** The first {@link HEAD_BYTES} of a file, as text. */
async function readHead(file: string): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * A bounded JSONL prefix made only from complete records.
 *
 * The final record is allowed to cross the byte target so a large injected
 * preamble is never cut into invalid JSON. Codex needs this because its
 * guidance can already exceed the small generic history head.
 */
async function readCodexHead(file: string): Promise<string> {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const head: string[] = [];
  let bytesRead = 0;
  try {
    for await (const line of lines) {
      head.push(line);
      bytesRead += Buffer.byteLength(line, "utf8") + 1;
      if (bytesRead >= CODEX_HEAD_BYTES) break;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return head.join("\n");
}

function parseTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/** Same directory, allowing for case and separators on Windows. */
function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

/**
 * The wrapper the CLIs put around a prompt, stripped back to what the user
 * actually typed. Anything left that is markup rather than a request —
 * an environment preamble, a slash-command echo, the resume caveat — is not
 * a topic, and the next line gets the chance instead.
 */
function cleanUserText(raw: string): string {
  let text = raw.trim();
  const marker = text.lastIndexOf("## My request for Codex:");
  if (marker >= 0) {
    text = text.slice(marker + "## My request for Codex:".length).trim();
  }
  if (!text || text.startsWith("<")) return "";
  if (text.startsWith("# AGENTS.md instructions")) return "";
  if (text.startsWith("Caveat:")) return "";
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.slice(0, MAX_TITLE_CHARS);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The text of a message whose content is a string or a block array. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec) continue;
    const type = typeof rec.type === "string" ? rec.type : "";
    if (type && type !== "text" && type !== "input_text") continue;
    if (typeof rec.text === "string") parts.push(rec.text);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------- codex

/**
 * A Codex rollout line, in any of the shapes the CLI has written:
 * `{type:"session_meta",payload:{...}}`, `{type:"response_item",payload:
 * {type:"message",role:"user",...}}`, `{type:"event_msg",payload:{type:
 * "user_message",message}}`, and the older un-enveloped records. Unknown
 * lines simply contribute nothing.
 */
function codexUserText(record: Record<string, unknown>): string {
  const payload = asRecord(record.payload) ?? record;
  if (payload.type === "user_message" && typeof payload.message === "string") {
    return cleanUserText(payload.message);
  }
  if (payload.role === "user") return cleanUserText(contentText(payload.content));
  return "";
}

function parseCodexRollout(
  text: string,
  file: string,
  mtime: number
): CliHistoryEntry | null {
  let id = "";
  let cwd = "";
  let startedAt = 0;
  let title = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: Record<string, unknown> | null;
    try {
      record = asRecord(JSON.parse(trimmed));
    } catch {
      continue; // truncated tail of the head read, or a stray line
    }
    if (!record) continue;
    const payload = asRecord(record.payload) ?? record;
    if (!id && typeof payload.id === "string") id = payload.id;
    if (!cwd && typeof payload.cwd === "string") cwd = payload.cwd;
    if (!startedAt) {
      startedAt =
        parseTimestamp(record.timestamp) || parseTimestamp(payload.timestamp);
    }
    if (!title) title = codexUserText(record);
    if (id && cwd && title) break;
  }
  // `rollout-<timestamp>-<uuid>.jsonl` — the id is in the name even when the
  // header line is one this parser does not know.
  if (!id) {
    const match = /-([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i.exec(file);
    id = match?.[1] ?? "";
  }
  if (!id) return null;
  return {
    id,
    providerId: "codex",
    title,
    startedAt: startedAt || mtime,
    updatedAt: mtime,
    cwd,
  };
}

async function codexHistory(workspaceRoot: string): Promise<CliHistoryEntry[]> {
  const root = path.join(os.homedir(), ".codex", "sessions");
  const files = await walkJsonl(root);
  const entries: CliHistoryEntry[] = [];
  for (const { file, mtime } of files) {
    try {
      const entry = parseCodexRollout(await readCodexHead(file), file, mtime);
      // A rollout with no cwd predates the field; it cannot be claimed for
      // this workspace, so it stays out rather than showing up everywhere.
      if (entry && entry.cwd && sameDir(entry.cwd, workspaceRoot)) {
        entries.push(entry);
      }
    } catch {
      // unreadable transcript — skip this one, keep the rest
    }
  }
  return entries;
}

// --------------------------------------------------------------- claude

/**
 * Claude Code's per-project transcript directory. The project's path is the
 * directory name with every non-alphanumeric character replaced by a dash —
 * `C:\Users\me\atelier` becomes `C--Users-me-atelier`.
 */
function claudeProjectDir(workspaceRoot: string): string {
  const slug = path.resolve(workspaceRoot).replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", slug);
}

function parseClaudeTranscript(
  text: string,
  file: string,
  mtime: number
): CliHistoryEntry | null {
  let id = "";
  let startedAt = 0;
  let title = "";
  let cwd = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: Record<string, unknown> | null;
    try {
      record = asRecord(JSON.parse(trimmed));
    } catch {
      continue;
    }
    if (!record) continue;
    if (!id && typeof record.sessionId === "string") id = record.sessionId;
    if (!cwd && typeof record.cwd === "string") cwd = record.cwd;
    if (!startedAt) startedAt = parseTimestamp(record.timestamp);
    // Sidechains are subagent transcripts; their first prompt is Atelier's
    // wording, not the user's, so they never name the session.
    if (!title && record.type === "user" && !record.isMeta && !record.isSidechain) {
      const message = asRecord(record.message);
      if (message) title = cleanUserText(contentText(message.content));
    }
    if (id && cwd && title) break;
  }
  if (!id) id = path.basename(file, ".jsonl");
  if (!id) return null;
  return {
    id,
    providerId: "claude",
    title,
    startedAt: startedAt || mtime,
    updatedAt: mtime,
    cwd,
  };
}

async function claudeHistory(workspaceRoot: string): Promise<CliHistoryEntry[]> {
  const dir = claudeProjectDir(workspaceRoot);
  const files = await walkJsonl(dir);
  const entries: CliHistoryEntry[] = [];
  for (const { file, mtime } of files) {
    try {
      const entry = parseClaudeTranscript(await readHead(file), file, mtime);
      // The directory already IS this workspace, so an entry whose lines
      // carry no cwd is still ours.
      if (entry && (!entry.cwd || sameDir(entry.cwd, workspaceRoot))) {
        entries.push(entry);
      }
    } catch {
      // unreadable transcript — skip
    }
  }
  return entries;
}

const READERS: Record<
  string,
  (workspaceRoot: string) => Promise<CliHistoryEntry[]>
> = {
  codex: codexHistory,
  claude: claudeHistory,
};

/**
 * This workspace's CLI sessions as the providers themselves recorded them,
 * newest first, capped per provider.
 */
export async function listCliHistory(
  workspaceRoot: string,
  providerId?: string,
  limit = 20
): Promise<CliHistoryEntry[]> {
  const wanted = providerId ? [providerId] : Object.keys(READERS);
  const perProvider = await Promise.all(
    wanted.map(async (id) => {
      const read = READERS[id];
      if (!read) return [];
      try {
        const entries = await read(workspaceRoot);
        entries.sort((a, b) => b.updatedAt - a.updatedAt);
        return entries.slice(0, Math.max(1, limit));
      } catch {
        return [];
      }
    })
  );
  return perProvider.flat().sort((a, b) => b.updatedAt - a.updatedAt);
}
