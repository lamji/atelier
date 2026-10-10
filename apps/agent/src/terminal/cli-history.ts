import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type { CliHistoryEntry } from "@atelier/protocol";
import { conversationTitle } from "@atelier/shared";

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

const WALK_CACHE_MS = 30_000;
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
const CONTEXT_TAIL_BYTES = 2 * 1024 * 1024;
/** Row labels are truncated in the UI; this only stops absurd strings. */
const MAX_TITLE_CHARS = 200;

interface WalkedFile {
  file: string;
  mtime: number;
}

const walkCache = new Map<string, { expiresAt: number; files: WalkedFile[] }>();

/**
 * JSONL files under `root`, newest first.
 *
 * Directories are visited in reverse name order, which for Codex's
 * `YYYY/MM/DD` layout means the newest days are walked first.
 */
async function walkJsonl(root: string, refresh = false): Promise<WalkedFile[]> {
  const cached = walkCache.get(root);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.files;
  const out: WalkedFile[] = [];
  const stack = [root];
  while (stack.length > 0) {
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
    }
    // Ascending push, LIFO pop: the newest-named directory comes out first.
    dirs.sort();
    stack.push(...dirs);
  }
  out.sort((a, b) => b.mtime - a.mtime);
  walkCache.set(root, { expiresAt: Date.now() + WALK_CACHE_MS, files: out });
  return out;
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
function codexRawUserText(record: Record<string, unknown>): string {
  const payload = asRecord(record.payload) ?? record;
  if (payload.type === "user_message" && typeof payload.message === "string") {
    return payload.message;
  }
  if (payload.role === "user") return contentText(payload.content);
  return "";
}

function codexUserText(record: Record<string, unknown>): string {
  return cleanUserText(codexRawUserText(record));
}

/** A bounded suffix of the current transcript, omitting a partial first line. */
async function readContextTail(file: string): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - CONTEXT_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } finally {
    await handle.close();
  }
}

/** Derive a concise label from the latest meaningful user request. */
export function titleFromCliTranscript(providerId: string, text: string): string {
  const requests: string[] = [];
  for (const line of text.split("\n")) {
    let record: Record<string, unknown> | null;
    try {
      record = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (!record) continue;
    let request = "";
    if (providerId === "codex") {
      request = codexRawUserText(record);
    } else if (providerId === "claude" && record.type === "user" &&
               !record.isMeta && !record.isSidechain) {
      request = contentText(asRecord(record.message)?.content);
    }
    request = cleanUserText(request
      .replace(/<image\b[^>]*>/gi, " ")
      .replace(/\[Image #[^\]]+\]/gi, " "))
      .replace(/^(?:next|please|now|i need|can you|could you)(?:\s+|:\s*|,\s*|-\s+)/i, "")
      .trim();
    if (!request || request.startsWith("/") ||
        /^(?:continue|yes|ok|okay|go ahead|do it|fix it|keep going|try again)[.!? ]*$/i.test(request)) {
      continue;
    }
    if (requests.at(-1) !== request) requests.push(request);
  }
  const recent = requests.slice(-12).reverse();
  const meaningful = recent.find((request) => request.length >= 12 && request.split(/\s+/).length >= 3);
  return conversationTitle(meaningful ?? recent[0] ?? "");
}

/** Find the active provider transcript by its native resume ID. */
export async function suggestCliSessionTitle(
  workspaceRoot: string,
  providerId: string,
  sessionId: string
): Promise<string> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return "";
  let file: string | undefined;
  if (providerId === "claude") {
    file = path.join(claudeProjectDir(workspaceRoot), `${sessionId}.jsonl`);
  } else if (providerId === "codex") {
    const root = path.join(os.homedir(), ".codex", "sessions");
    const matchesId = (entry: WalkedFile) =>
      path.basename(entry.file).toLowerCase().endsWith(`-${sessionId.toLowerCase()}.jsonl`);
    file = (await walkJsonl(root)).find(matchesId)?.file;
    if (!file) file = (await walkJsonl(root, true)).find(matchesId)?.file;
    if (file) {
      const metadata = parseCodexRollout(await readCodexHead(file), file, 0);
      if (!metadata?.cwd || !sameDir(metadata.cwd, workspaceRoot)) return "";
    }
  }
  if (!file) return "";
  try {
    return titleFromCliTranscript(providerId, await readContextTail(file));
  } catch {
    return "";
  }
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

interface HistoryScan {
  entries: CliHistoryEntry[];
  hasMore: boolean;
}

async function codexHistory(workspaceRoot: string, offset: number, limit: number): Promise<HistoryScan> {
  const root = path.join(os.homedir(), ".codex", "sessions");
  const files = await walkJsonl(root, offset === 0);
  const entries: CliHistoryEntry[] = [];
  for (const { file, mtime } of files.slice(offset, offset + limit)) {
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
  return { entries, hasMore: files.length > offset + limit };
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

async function claudeHistory(workspaceRoot: string, offset: number, limit: number): Promise<HistoryScan> {
  const dir = claudeProjectDir(workspaceRoot);
  const files = await walkJsonl(dir, offset === 0);
  const entries: CliHistoryEntry[] = [];
  for (const { file, mtime } of files.slice(offset, offset + limit)) {
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
  return { entries, hasMore: files.length > offset + limit };
}

const READERS: Record<
  string,
  (workspaceRoot: string, offset: number, limit: number) => Promise<HistoryScan>
> = {
  codex: codexHistory,
  claude: claudeHistory,
};

/**
 * This workspace's CLI sessions as the providers themselves recorded them,
 * newest first, capped per provider.
 */
export async function scanCliHistoryPage(
  workspaceRoot: string,
  providerId?: string,
  offset = 0,
  limit = 30
): Promise<HistoryScan> {
  const wanted = providerId ? [providerId] : Object.keys(READERS);
  const perProvider = await Promise.all(
    wanted.map(async (id) => {
      const read = READERS[id];
      if (!read) return { entries: [], hasMore: false };
      try {
        return await read(workspaceRoot, offset, limit);
      } catch {
        return { entries: [], hasMore: false };
      }
    })
  );
  return {
    entries: perProvider.flatMap((result) => result.entries).sort((a, b) => b.updatedAt - a.updatedAt),
    hasMore: perProvider.some((result) => result.hasMore),
  };
}
