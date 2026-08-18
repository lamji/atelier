import { createHash } from "node:crypto";
import { approxTokens, clipToTokens, toPosix } from "@atelier/shared";
import type { Db } from "../../storage/db.js";

/**
 * Per-conversation record of what the agent already LOOKED AT: the files
 * it read (with the exact range and a hash of what it saw) and the
 * searches it ran.
 *
 * Every provider starts each turn on a fresh transcript — continuity is
 * Atelier-owned context — and that context used to carry what was SAID
 * (summaries, recent turns) but not what was SEEN. So a follow-up like
 * "now also handle X" began by re-reading the same three files the last
 * turn had just read, and on Ollama the edit-grounding guard then
 * demanded those reads before it would allow an edit at all. This is the
 * missing half: the investigation, remembered.
 *
 * Reads are stored as addresses, never as content. Recall re-reads the
 * file NOW, so what is inlined is always the current bytes; the stored
 * hash only says whether it changed since the agent last looked.
 */
export class WorkingMemoryStore {
  constructor(private db: Db) {}

  /** A successful read of `path` (whole file when offset/limit are absent). */
  noteRead(input: {
    conversationId: string;
    taskId: string;
    path: string;
    offset?: number;
    limit?: number;
    content: string;
  }): void {
    const path = toPosix(input.path).replace(/^\.\//, "");
    if (!path) return;
    const meta: ReadMeta = {
      path,
      offset: input.offset,
      limit: input.limit,
      hash: hashOf(input.content),
      chars: input.content.length,
    };
    this.write(input.conversationId, "read", readKey(meta), input.taskId, meta);
  }

  /** A search that returned something; `paths` are what it pointed at. */
  noteSearch(input: {
    conversationId: string;
    taskId: string;
    tool: string;
    query: string;
    paths: string[];
  }): void {
    const query = input.query.trim();
    if (!query) return;
    const meta: SearchMeta = {
      tool: input.tool,
      query: query.slice(0, 200),
      paths: [...new Set(input.paths.map((p) => toPosix(p)))].slice(0, 8),
    };
    this.write(
      input.conversationId,
      "search",
      `${meta.tool}:${meta.query}`,
      input.taskId,
      meta
    );
  }

  /**
   * Routes a finished tool call to the right note. Called from the
   * pipeline's own bus subscription, which is where the conversation id
   * is known; the registry that publishes the events only knows the task.
   */
  noteTool(input: {
    conversationId: string;
    taskId: string;
    name: string;
    input: unknown;
    result: unknown;
  }): void {
    const args = (input.input ?? {}) as Record<string, unknown>;
    const { conversationId, taskId } = input;
    if (input.name === "read_file") {
      const content = (input.result as { content?: unknown } | null)?.content;
      if (typeof args.path !== "string" || typeof content !== "string") return;
      this.noteRead({
        conversationId,
        taskId,
        path: args.path,
        offset: numberOr(args.offset),
        limit: numberOr(args.limit),
        content,
      });
      return;
    }
    if (input.name === "read_many_files") {
      if (!Array.isArray(input.result)) return;
      for (const entry of input.result as Array<Record<string, unknown>>) {
        if (typeof entry?.path !== "string") continue;
        if (typeof entry.content !== "string") continue;
        this.noteRead({
          conversationId,
          taskId,
          path: entry.path,
          offset: numberOr(entry.offset),
          limit: numberOr(entry.limit),
          content: entry.content,
        });
      }
      return;
    }
    if (!SEARCH_TOOLS.has(input.name)) return;
    const query =
      typeof args.query === "string"
        ? args.query
        : typeof args.target === "string"
          ? args.target
          : "";
    if (!query) return;
    this.noteSearch({
      conversationId,
      taskId,
      tool: input.name,
      query,
      paths: pathsInResult(input.result),
    });
  }

  /**
   * The block for a new turn. Reads from EARLIER tasks only — the current
   * task's own reads are in its transcript already — newest first, with
   * the most recent ones re-read and inlined while the budget lasts and
   * the rest listed as paths.
   */
  async recall(input: RecallInput): Promise<RecalledWorkingMemory> {
    const rows = this.rows(input.conversationId, input.currentTaskId);
    if (rows.length === 0 && (input.seedPaths ?? []).length === 0) {
      return EMPTY_RECALL;
    }
    const reads = rows.filter((row) => row.kind === "read");
    const searches = rows.filter((row) => row.kind === "search");
    // The tasks this conversation ran before this one, newest first: a
    // read from the last task is worth inlining, one from six tasks ago
    // is worth a mention.
    const recentTasks = [...new Set(rows.map((row) => row.taskId))].slice(
      0,
      INLINE_TASK_DEPTH
    );

    const inlined: InlinedRead[] = [];
    const listed: Array<{ meta: ReadMeta; note: string }> = [];
    let remaining = input.maxTokens;
    let changed = 0;
    const seenPaths = new Set<string>();

    for (const row of reads.slice(0, MAX_READS)) {
      const meta = row.meta as ReadMeta;
      // One entry per path: the newest range read wins, older ranges of
      // the same file only add noise to the list.
      if (seenPaths.has(meta.path)) continue;
      seenPaths.add(meta.path);
      const eligible =
        recentTasks.includes(row.taskId) &&
        !input.excludePaths?.has(meta.path);
      let current: { content: string; totalLines?: number } | null = null;
      if (eligible && remaining > MIN_INLINE_TOKENS) {
        current = await input.files
          .readFile(meta.path, { offset: meta.offset, limit: meta.limit })
          .catch(() => null);
      }
      if (!current) {
        listed.push({ meta, note: "" });
        continue;
      }
      const unchanged = hashOf(current.content) === meta.hash;
      if (!unchanged) changed += 1;
      const cost = approxTokens(current.content);
      const cap = Math.min(remaining, PER_FILE_TOKENS);
      const clipped = cost > cap;
      const text = clipped ? clipToTokens(current.content, cap) : current.content;
      inlined.push({
        meta,
        text,
        unchanged,
        clipped,
        totalLines: current.totalLines,
      });
      remaining -= approxTokens(text);
    }

    // Wiki-named owner files, after the conversation's own reads: those are
    // the files a follow-up on that feature edits first.
    const seeded: InlinedRead[] = [];
    for (const raw of input.seedPaths ?? []) {
      if (remaining <= MIN_INLINE_TOKENS || seeded.length >= MAX_SEED_FILES) break;
      const path = toPosix(raw).replace(/^\.\//, "");
      if (seenPaths.has(path) || input.excludePaths?.has(path)) continue;
      seenPaths.add(path);
      const current = await input.files.readFile(path).catch(() => null);
      if (!current) continue;
      const cost = approxTokens(current.content);
      const cap = Math.min(remaining, PER_FILE_TOKENS);
      const clipped = cost > cap;
      const text = clipped ? clipToTokens(current.content, cap) : current.content;
      seeded.push({
        meta: { path, hash: "", chars: current.content.length },
        text,
        unchanged: true,
        clipped,
        totalLines: current.totalLines,
      });
      remaining -= approxTokens(text);
    }

    if (
      inlined.length === 0 &&
      listed.length === 0 &&
      searches.length === 0 &&
      seeded.length === 0
    ) {
      return EMPTY_RECALL;
    }

    const lines: string[] = [HEADER];
    if (inlined.length > 0 || listed.length > 0) {
      lines.push(
        "Files already read in earlier turns (newest first). Those inlined " +
          "below are the CURRENT content, re-read for this turn — treat them " +
          "as read; do not call read_file for the same range again:"
      );
      for (const item of inlined) {
        lines.push(
          `- ${item.meta.path}${rangeLabel(item.meta)} — ` +
            (item.unchanged ? "unchanged since" : "CHANGED since it was read") +
            (item.clipped
              ? "; only the start is inlined, read_file the rest if needed"
              : "; inlined below")
        );
      }
      for (const item of listed) {
        lines.push(
          `- ${item.meta.path}${rangeLabel(item.meta)} — read earlier, not ` +
            "inlined; read_file it again only if this turn needs it"
        );
      }
    }
    if (searches.length > 0) {
      lines.push("Searches already run (query → what they pointed at):");
      for (const row of searches.slice(0, MAX_SEARCHES)) {
        const meta = row.meta as SearchMeta;
        const hits =
          meta.paths.length > 0 ? meta.paths.join(", ") : "no file hits";
        lines.push(`- ${meta.tool} "${meta.query}" → ${hits}`);
      }
    }
    if (seeded.length > 0) {
      lines.push(
        "Owner files named by the matched feature-wiki page (current " +
          "content, inlined so the feature can be edited without opening " +
          "them first):"
      );
      for (const item of seeded) {
        lines.push(
          `- ${item.meta.path}` +
            (item.clipped ? " — only the start is inlined" : " — inlined below")
        );
      }
    }
    for (const item of [...inlined, ...seeded]) {
      lines.push(`--- ${item.meta.path}${rangeLabel(item.meta)} ---`);
      lines.push(item.text);
    }
    const text = lines.join("\n");
    return {
      text,
      tokens: approxTokens(text),
      inlined: inlined.length,
      listed: listed.length,
      changed,
      searches: Math.min(searches.length, MAX_SEARCHES),
      // Grounded means "the model has the exact current bytes": a clipped
      // file does not qualify, an edit against its unseen tail would be
      // exactly the blind patch the guard exists to refuse.
      groundedPaths: [...inlined, ...seeded]
        .filter((item) => !item.clipped)
        .map((item) => item.meta.path),
      inlinedPaths: [...inlined, ...seeded].map((item) => item.meta.path),
      seeded: seeded.length,
    };
  }

  /** Paths one task read, newest first — for the wiki compiler. */
  readsForTask(conversationId: string, taskId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT meta FROM conversation_working_memory " +
          "WHERE conversation_id = ? AND task_id = ? AND kind = 'read' " +
          "ORDER BY noted_at DESC LIMIT 40"
      )
      .all(conversationId, taskId) as Array<{ meta: string }>;
    const paths: string[] = [];
    for (const row of rows) {
      try {
        const meta = JSON.parse(row.meta) as ReadMeta;
        if (meta.path && !paths.includes(meta.path)) paths.push(meta.path);
      } catch {
        // skip
      }
    }
    return paths;
  }

  clear(conversationId: string): void {
    this.db
      .prepare(
        "DELETE FROM conversation_working_memory WHERE conversation_id = ?"
      )
      .run(conversationId);
  }

  private write(
    conversationId: string,
    kind: MemoryKind,
    key: string,
    taskId: string,
    meta: ReadMeta | SearchMeta
  ): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO conversation_working_memory(" +
          "conversation_id, kind, key, task_id, meta, noted_at) " +
          "VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(conversationId, kind, key, taskId, JSON.stringify(meta), Date.now());
  }

  private rows(conversationId: string, excludeTaskId: string): MemoryRow[] {
    const raw = this.db
      .prepare(
        "SELECT kind, key, task_id, meta, noted_at " +
          "FROM conversation_working_memory " +
          "WHERE conversation_id = ? AND task_id != ? " +
          "ORDER BY noted_at DESC LIMIT ?"
      )
      .all(conversationId, excludeTaskId, MAX_ROWS) as Array<{
      kind: string;
      key: string;
      task_id: string;
      meta: string;
      noted_at: number;
    }>;
    const rows: MemoryRow[] = [];
    for (const row of raw) {
      try {
        rows.push({
          kind: row.kind as MemoryKind,
          key: row.key,
          taskId: row.task_id,
          meta: JSON.parse(row.meta) as ReadMeta | SearchMeta,
          notedAt: row.noted_at,
        });
      } catch {
        // A row that will not parse is dropped, not fatal.
      }
    }
    return rows;
  }
}

/**
 * Collects every `path` string in a tool result, however nested — search
 * matches, retrieved chunks, symbol hits and graph nodes all name their
 * file that way. Deduped, capped, and tolerant of any shape.
 */
export function pathsInResult(result: unknown, cap = 8): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    if (found.length >= cap || depth > 4 || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.path === "string" && record.path) {
      const path = toPosix(record.path);
      if (!seen.has(path)) {
        seen.add(path);
        found.push(path);
      }
    }
    for (const nested of Object.values(record)) {
      if (typeof nested === "object") walk(nested, depth + 1);
    }
  };
  walk(result, 0);
  return found;
}

export interface RecallInput {
  conversationId: string;
  currentTaskId: string;
  files: {
    readFile(
      relPath: string,
      opts?: { offset?: number; limit?: number }
    ): Promise<{ content: string; totalLines?: number }>;
  };
  /** Cap for the whole block, inlined content included. */
  maxTokens: number;
  /** Paths not to inline (already carried by another section this turn). */
  excludePaths?: Set<string>;
  /**
   * Owner files named by a matched feature-wiki page: inlined after the
   * conversation's own reads while budget remains, so a turn that opens
   * on a known feature holds its entry files without a single read call.
   */
  seedPaths?: string[];
}

export interface RecalledWorkingMemory {
  text: string;
  tokens: number;
  /** Files whose current content rides in the block. */
  inlined: number;
  /** Files mentioned by path only. */
  listed: number;
  /** Inlined files whose bytes differ from what the agent last saw. */
  changed: number;
  searches: number;
  /** Inlined in full — the model holds the exact current bytes. */
  groundedPaths: string[];
  inlinedPaths: string[];
  /** Owner files inlined from a feature-wiki page rather than from a read. */
  seeded: number;
}

export const EMPTY_RECALL: RecalledWorkingMemory = {
  text: "",
  tokens: 0,
  inlined: 0,
  listed: 0,
  changed: 0,
  searches: 0,
  groundedPaths: [],
  inlinedPaths: [],
  seeded: 0,
};

const HEADER =
  "\nPREVIOUSLY GATHERED CONTEXT (what this conversation already looked " +
  "at — reuse it instead of investigating from scratch):";
/** Reads from the last N tasks are inlined; older ones are listed. */
const INLINE_TASK_DEPTH = 3;
const MAX_ROWS = 80;
const MAX_READS = 12;
const MAX_SEARCHES = 8;
const PER_FILE_TOKENS = 1200;
/** Owner files a wiki page may pull in on top of the conversation's reads. */
const MAX_SEED_FILES = 3;
const MIN_INLINE_TOKENS = 120;

type MemoryKind = "read" | "search";

const SEARCH_TOOLS = new Set([
  "search_text",
  "search_workspace",
  "search_symbols",
  "retrieve_knowledge",
  "query_knowledge_graph",
]);

function numberOr(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface ReadMeta {
  path: string;
  offset?: number;
  limit?: number;
  hash: string;
  chars: number;
}

interface SearchMeta {
  tool: string;
  query: string;
  paths: string[];
}

interface MemoryRow {
  kind: MemoryKind;
  key: string;
  taskId: string;
  meta: ReadMeta | SearchMeta;
  notedAt: number;
}

interface InlinedRead {
  meta: ReadMeta;
  text: string;
  unchanged: boolean;
  clipped: boolean;
  totalLines?: number;
}

function readKey(meta: ReadMeta): string {
  return `${meta.path}#${meta.offset ?? ""}-${meta.limit ?? ""}`;
}

function rangeLabel(meta: ReadMeta): string {
  if (meta.offset === undefined && meta.limit === undefined) return "";
  const start = meta.offset ?? 1;
  const end = meta.limit === undefined ? "end" : String(start + meta.limit - 1);
  return ` (lines ${start}-${end})`;
}

function hashOf(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}
