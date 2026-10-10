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

  /**
   * A search that returned something; `paths` are what it pointed at and
   * `hits` (optional) carry the line each path matched on, so a later
   * turn can re-open the exact spot instead of the whole file.
   */
  noteSearch(input: {
    conversationId: string;
    taskId: string;
    tool: string;
    query: string;
    paths: string[];
    hits?: SearchHit[];
  }): void {
    const query = input.query.trim();
    if (!query) return;
    const paths = [...new Set(input.paths.map((p) => toPosix(p)))].slice(0, 8);
    const hits = (input.hits ?? [])
      .map((hit) => ({ ...hit, path: toPosix(hit.path) }))
      .filter((hit) => paths.includes(hit.path))
      .slice(0, 8);
    const meta: SearchMeta = {
      tool: input.tool,
      query: query.slice(0, 200),
      paths,
      ...(hits.length > 0 ? { hits } : {}),
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
    if (input.name === "run_terminal") {
      const result = (input.result ?? {}) as {
        exitCode?: unknown;
        output?: unknown;
        timedOut?: unknown;
      };
      if (typeof args.command !== "string") return;
      this.noteCommand({
        conversationId,
        taskId,
        command: args.command,
        exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
        output: typeof result.output === "string" ? result.output : "",
        timedOut: result.timedOut === true,
      });
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
    const hits = hitsInResult(input.result);
    this.noteSearch({
      conversationId,
      taskId,
      tool: input.name,
      query,
      paths: hits.map((hit) => hit.path),
      hits,
    });
  }

  /**
   * A file this task changed. What was DONE, as distinct from what was
   * read: the next turn's "it's still broken" is about these files.
   */
  noteEdit(input: { conversationId: string; taskId: string; path: string }): void {
    const path = toPosix(input.path).replace(/^\.\//, "");
    if (!path) return;
    const meta: EditMeta = { path };
    this.write(input.conversationId, "edit", `edit:${path}`, input.taskId, meta);
  }

  /**
   * A command this task ran, with how it ended. The native transcript the
   * CLI replays carries the whole output; this keeps the command, the exit
   * code and the last line — enough to know what was tried and whether it
   * worked, at a few dozen tokens instead of thousands.
   */
  noteCommand(input: {
    conversationId: string;
    taskId: string;
    command: string;
    exitCode: number | null;
    output: string;
    timedOut: boolean;
  }): void {
    const command = input.command.trim();
    if (!command) return;
    const meta: CommandMeta = {
      command: command.slice(0, COMMAND_CHARS),
      exitCode: input.exitCode,
      timedOut: input.timedOut,
      tail: lastLine(input.output),
    };
    this.write(
      input.conversationId,
      "command",
      `cmd:${meta.command}`,
      input.taskId,
      meta
    );
  }

  /**
   * What the tasks BEFORE this one did, newest task first: files edited,
   * commands run (with outcome), files read and searches made. Addresses
   * and outcomes only — never content — so the whole record of a turn's
   * work costs a fraction of replaying its transcript.
   */
  actions(
    conversationId: string,
    excludeTaskId: string,
    maxTasks = 2
  ): TaskActions[] {
    const raw = this.db
      .prepare(
        "SELECT kind, task_id, meta, noted_at FROM conversation_working_memory " +
          "WHERE conversation_id = ? AND task_id != ? " +
          "ORDER BY noted_at DESC LIMIT ?"
      )
      .all(conversationId, excludeTaskId, MAX_ROWS) as Array<{
      kind: string;
      task_id: string;
      meta: string;
      noted_at: number;
    }>;
    const byTask = new Map<string, TaskActions>();
    for (const row of raw) {
      let meta: ReadMeta | SearchMeta | EditMeta | CommandMeta;
      try {
        meta = JSON.parse(row.meta) as typeof meta;
      } catch {
        continue;
      }
      let group = byTask.get(row.task_id);
      if (!group) {
        if (byTask.size >= maxTasks) continue;
        group = {
          taskId: row.task_id,
          edits: [],
          commands: [],
          reads: [],
          searches: [],
        };
        byTask.set(row.task_id, group);
      }
      if (row.kind === "edit") {
        const path = (meta as EditMeta).path;
        if (!group.edits.includes(path)) group.edits.push(path);
      } else if (row.kind === "command") {
        group.commands.push(meta as CommandMeta);
      } else if (row.kind === "read") {
        const read = meta as ReadMeta;
        const label = `${read.path}${rangeLabel(read)}`;
        if (!group.reads.includes(label)) group.reads.push(label);
      } else if (row.kind === "search") {
        const search = meta as SearchMeta;
        group.searches.push({ query: search.query, paths: search.paths });
      }
    }
    return [...byTask.values()];
  }

  /**
   * The block for a new turn. Reads from EARLIER tasks only — the current
   * task's own reads are in its transcript already — newest first, with
   * the most recent ones re-read and inlined while the budget lasts and
   * the rest listed as paths.
   */
  async recall(input: RecallInput): Promise<RecalledWorkingMemory> {
    const rows = this.rows(input.conversationId, input.currentTaskId);
    const preferPaths = [
      ...new Set(
        (input.preferPaths ?? [])
          .map((raw) => toPosix(raw).replace(/^\.\//, ""))
          .filter(Boolean)
      ),
    ];
    if (
      rows.length === 0 &&
      (input.seedPaths ?? []).length === 0 &&
      preferPaths.length === 0
    ) {
      return EMPTY_RECALL;
    }
    const reads = rows.filter((row) => row.kind === "read");
    const searches = rows.filter((row) => row.kind === "search");
    const demoted = input.demoteTaskIds ?? new Set<string>();
    // The tasks this conversation ran before this one, newest first: a
    // read from the last task is worth inlining, one from six tasks ago
    // is worth a mention. A task the user stopped does not take a slot:
    // its reads are the trail of an attempt that was wrong enough to
    // interrupt, and inlining them by recency is how the next turn walked
    // straight back to the same wrong file.
    const recentTasks = [
      ...new Set(
        rows.map((row) => row.taskId).filter((taskId) => !demoted.has(taskId))
      ),
    ].slice(0, INLINE_TASK_DEPTH);
    const literals = (input.literals ?? [])
      .map((literal) => literal.trim().toLowerCase())
      .filter((literal) => literal.length >= MIN_LITERAL_CHARS);
    const locatedHits = literals.length > 0 ? locateHits(searches, literals) : [];
    // The located section gets a guaranteed slice: the files a search for
    // the user's own words pointed at are the most likely true target, and
    // they must not lose to a run of recency-ordered reads.
    const reserve =
      locatedHits.length > 0 ? Math.floor(input.maxTokens * LOCATED_SHARE) : 0;

    const preferred: InlinedRead[] = [];
    const inlined: InlinedRead[] = [];
    const listed: Array<{ meta: ReadMeta; note: string }> = [];
    let remaining = input.maxTokens;
    let changed = 0;
    const seenPaths = new Set<string>();
    const readMetaFor = (path: string): ReadMeta | undefined =>
      reads.map((row) => row.meta as ReadMeta).find((meta) => meta.path === path);

    // Files the user named THIS turn come first, whether or not any
    // earlier turn read them: the request is about them by definition.
    for (const path of preferPaths) {
      if (preferred.length >= MAX_PREFERRED_FILES) break;
      if (input.excludePaths?.has(path)) continue;
      if (remaining - reserve <= MIN_INLINE_TOKENS) break;
      const current = await input.files.readFile(path).catch(() => null);
      if (!current) continue;
      seenPaths.add(path);
      const earlier = readMetaFor(path);
      // A prior whole-file read tells whether the bytes moved since; a
      // range read or no read at all cannot, and "unchanged" is the honest
      // default for a file nobody has looked at.
      const unchanged =
        earlier && earlier.offset === undefined && earlier.limit === undefined
          ? hashOf(current.content) === earlier.hash
          : true;
      if (!unchanged) changed += 1;
      const cap = Math.min(remaining - reserve, PER_FILE_TOKENS);
      const clipped = approxTokens(current.content) > cap;
      const text = clipped ? clipToTokens(current.content, cap) : current.content;
      preferred.push({
        meta: { path, hash: earlier?.hash ?? "", chars: current.content.length },
        text,
        unchanged,
        clipped,
        totalLines: current.totalLines,
      });
      remaining -= approxTokens(text);
    }

    for (const row of reads.slice(0, MAX_READS)) {
      const meta = row.meta as ReadMeta;
      // One entry per path: the newest range read wins, older ranges of
      // the same file only add noise to the list.
      if (seenPaths.has(meta.path)) continue;
      seenPaths.add(meta.path);
      if (demoted.has(row.taskId)) {
        listed.push({ meta, note: DEMOTED_NOTE });
        continue;
      }
      const eligible =
        recentTasks.includes(row.taskId) &&
        !input.excludePaths?.has(meta.path);
      let current: { content: string; totalLines?: number } | null = null;
      if (eligible && remaining - reserve > MIN_INLINE_TOKENS) {
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
      const cap = Math.min(remaining - reserve, PER_FILE_TOKENS);
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

    // Files that earlier searches for this turn's named text pointed at.
    // A hit with a known line is shown as the window around it; one
    // without is shown from the top. Either way it is the CURRENT bytes.
    const located: LocatedRead[] = [];
    let locatedBudget = Math.min(reserve, remaining);
    for (const hit of locatedHits) {
      if (located.length >= MAX_LOCATED_FILES) break;
      if (locatedBudget <= MIN_INLINE_TOKENS) break;
      if (seenPaths.has(hit.path) || input.excludePaths?.has(hit.path)) continue;
      const offset =
        hit.line !== undefined ? Math.max(1, hit.line - LOCATED_CONTEXT_LINES) : 1;
      const limit =
        hit.line !== undefined ? LOCATED_CONTEXT_LINES * 2 + 1 : LOCATED_HEAD_LINES;
      const current = await input.files
        .readFile(hit.path, { offset, limit })
        .catch(() => null);
      if (!current || !current.content) continue;
      seenPaths.add(hit.path);
      const cap = Math.min(locatedBudget, PER_FILE_TOKENS);
      const clipped = approxTokens(current.content) > cap;
      const text = clipped ? clipToTokens(current.content, cap) : current.content;
      const total = current.totalLines;
      // "Whole" only when the window provably covers every line; a range
      // read of a file whose length is unknown is a partial view.
      const whole = total !== undefined && offset === 1 && offset + limit - 1 >= total;
      // The label must name the lines actually shown, not the window asked
      // for: a hit near the end of a file gets a shorter tail.
      const shown = total !== undefined ? Math.min(limit, total - offset + 1) : limit;
      const meta: ReadMeta = {
        path: hit.path,
        hash: "",
        chars: current.content.length,
        ...(whole ? {} : { offset, limit: shown }),
      };
      located.push({
        meta,
        text,
        unchanged: true,
        clipped,
        totalLines: total,
        query: hit.query,
        tool: hit.tool,
        whole,
      });
      const spent = approxTokens(text);
      locatedBudget -= spent;
      remaining -= spent;
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
      preferred.length === 0 &&
      inlined.length === 0 &&
      listed.length === 0 &&
      searches.length === 0 &&
      located.length === 0 &&
      seeded.length === 0
    ) {
      return EMPTY_RECALL;
    }

    const lines: string[] = [HEADER];
    if (preferred.length > 0) {
      lines.push(
        "Files the user named in THIS request (current content, inlined " +
          "first — these are the subject; look here before anywhere else):"
      );
      for (const item of preferred) {
        lines.push(
          `- ${item.meta.path} — named in this request` +
            (item.unchanged ? "" : "; CHANGED since it was last read") +
            (item.clipped
              ? "; only the start is inlined, read_file the rest if needed"
              : "; inlined below")
        );
      }
    }
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
          `- ${item.meta.path}${rangeLabel(item.meta)} — ` +
            (item.note
              ? `${item.note}; not inlined`
              : "read earlier, not inlined") +
            "; read_file it again only if this turn needs it"
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
    if (located.length > 0) {
      lines.push(
        "Files earlier searches located (current content). These searches " +
          "were for the text the user named; their hits are where that " +
          "text actually lives — start from them, not from the files above:"
      );
      for (const item of located) {
        lines.push(
          `- ${item.meta.path}${rangeLabel(item.meta)} — located by ` +
            `${item.tool} "${item.query}"` +
            (item.whole
              ? "; whole file inlined below"
              : "; the window around the hit is inlined below, read_file " +
                "the rest if needed")
        );
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
    const bodies = [...preferred, ...inlined, ...located, ...seeded];
    for (const item of bodies) {
      lines.push(`--- ${item.meta.path}${rangeLabel(item.meta)} ---`);
      lines.push(item.text);
    }
    const text = lines.join("\n");
    return {
      text,
      tokens: approxTokens(text),
      inlined: preferred.length + inlined.length,
      listed: listed.length,
      changed,
      searches: Math.min(searches.length, MAX_SEARCHES),
      // Grounded means "the model has the exact current bytes": a clipped
      // file does not qualify, an edit against its unseen tail would be
      // exactly the blind patch the guard exists to refuse. A located
      // window is a partial view for the same reason unless it covers the
      // whole file.
      groundedPaths: [
        ...[...preferred, ...inlined, ...seeded].filter((item) => !item.clipped),
        ...located.filter((item) => item.whole && !item.clipped),
      ].map((item) => item.meta.path),
      inlinedPaths: bodies.map((item) => item.meta.path),
      seeded: seeded.length,
      demoted: listed.filter((item) => item.note === DEMOTED_NOTE).length,
      located: located.length,
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

  /**
   * Searches EARLIER turns of this conversation already ran.
   *
   * The recall block renders these for the model to read. This returns
   * them as data so the repeat guard can also refuse to run them again:
   * a follow-up turn that re-greps what turn one already grepped is the
   * re-investigation the carried context exists to make unnecessary.
   */
  searchesBefore(
    conversationId: string,
    excludeTaskId: string
  ): SearchMeta[] {
    const rows = this.db
      .prepare(
        "SELECT meta FROM conversation_working_memory " +
          "WHERE conversation_id = ? AND task_id != ? AND kind = 'search' " +
          "ORDER BY noted_at DESC LIMIT 120"
      )
      .all(conversationId, excludeTaskId) as Array<{ meta: string }>;
    const searches: SearchMeta[] = [];
    for (const row of rows) {
      try {
        const meta = JSON.parse(row.meta) as SearchMeta;
        if (meta?.tool && meta.query) searches.push(meta);
      } catch {
        // A row we cannot parse is a row we cannot enforce against.
      }
    }
    return searches;
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
    meta: ReadMeta | SearchMeta | EditMeta | CommandMeta
  ): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO conversation_working_memory(" +
          "conversation_id, kind, key, task_id, meta, noted_at) " +
          "VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(conversationId, kind, key, taskId, JSON.stringify(meta), Date.now());
  }

  /** Reads and searches only — the rows `recall` inlines and lists. */
  private rows(conversationId: string, excludeTaskId: string): MemoryRow[] {
    const raw = this.db
      .prepare(
        "SELECT kind, key, task_id, meta, noted_at " +
          "FROM conversation_working_memory " +
          "WHERE conversation_id = ? AND task_id != ? " +
          "AND kind IN ('read', 'search') " +
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
  return hitsInResult(result, cap).map((hit) => hit.path);
}

/**
 * Like `pathsInResult`, but keeps the line each path matched on — the
 * first of `row` / `line` / `startLine` found beside the path (search_text
 * uses `row` for the number and `line` for the TEXT, so only numbers
 * count) — and a short snippet of the matched text when there is one.
 * One hit per path: the first match is the one a re-open should land on.
 */
export function hitsInResult(result: unknown, cap = 8): SearchHit[] {
  const found: SearchHit[] = [];
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
        const line = lineOf(record);
        const text = snippetOf(record);
        found.push({
          path,
          ...(line !== undefined ? { line } : {}),
          ...(text ? { text } : {}),
        });
      }
    }
    for (const nested of Object.values(record)) {
      if (typeof nested === "object") walk(nested, depth + 1);
    }
  };
  walk(result, 0);
  return found;
}

function lineOf(record: Record<string, unknown>): number | undefined {
  for (const key of ["row", "line", "startLine"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

/** The matched text of a hit, when the tool returned one as a string. */
function snippetOf(record: Record<string, unknown>): string | undefined {
  for (const key of ["line", "text", "preview", "snippet"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, HIT_TEXT_CHARS);
    }
  }
  return undefined;
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
  /**
   * Tasks the user stopped. Their reads are LISTED with a note saying so,
   * never inlined, and they do not count toward the inline depth — the
   * files a cancelled attempt opened are evidence of where it went wrong,
   * not of where the answer is.
   */
  demoteTaskIds?: Set<string>;
  /**
   * Files the user named this turn: inlined FIRST, before any earlier
   * read, even when no turn has read them before.
   */
  preferPaths?: string[];
  /**
   * This turn's named literals (quoted strings, on-screen text). Earlier
   * searches whose query or hits contain one get their hit files inlined
   * under "Files earlier searches located", inside a 35% sub-budget.
   */
  literals?: string[];
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
  /** Reads listed as "read by an attempt the user stopped". */
  demoted: number;
  /** Files inlined because an earlier search for a named literal hit them. */
  located: number;
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
  demoted: 0,
  located: 0,
};

const HEADER =
  "\nPREVIOUSLY GATHERED CONTEXT (what this conversation already looked " +
  "at — reuse it instead of investigating from scratch):";
/** Reads from the last N tasks are inlined; older ones are listed. */
const INLINE_TASK_DEPTH = 3;
const MAX_ROWS = 80;
const MAX_READS = 12;
const MAX_SEARCHES = 8;
const PER_FILE_TOKENS = 4000;
/** Owner files a wiki page may pull in on top of the conversation's reads. */
const MAX_SEED_FILES = 3;
const MIN_INLINE_TOKENS = 120;
/** Files the user named this turn that ride in ahead of everything. */
const MAX_PREFERRED_FILES = 4;
/** Share of the block reserved for files located by literal searches. */
const LOCATED_SHARE = 0.35;
const MAX_LOCATED_FILES = 4;
/** Lines shown either side of a located hit line. */
const LOCATED_CONTEXT_LINES = 40;
/** Lines shown from the top of a located file with no known hit line. */
const LOCATED_HEAD_LINES = 80;
/** Shorter literals ("ok", "id") match everything and locate nothing. */
const MIN_LITERAL_CHARS = 3;
const HIT_TEXT_CHARS = 160;
const DEMOTED_NOTE =
  "read by an attempt the user stopped — not a confirmed target";

type MemoryKind = "read" | "search" | "edit" | "command";

/** A recorded command is cut here; the shape of it is what matters. */
const COMMAND_CHARS = 200;
/** The last output line kept per command — an error or a "done". */
const TAIL_CHARS = 160;

interface EditMeta {
  path: string;
}

export interface CommandMeta {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  /** Last non-empty output line, clipped. */
  tail: string;
}

/** Everything one earlier task did, as addresses and outcomes. */
export interface TaskActions {
  taskId: string;
  edits: string[];
  commands: CommandMeta[];
  /** `path` or `path (lines a-b)`. */
  reads: string[];
  searches: Array<{ query: string; paths: string[] }>;
}

function lastLine(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  return last.length > TAIL_CHARS ? `${last.slice(0, TAIL_CHARS - 1)}…` : last;
}

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

export interface SearchHit {
  path: string;
  /** 1-based line the match sits on, when the tool reported one. */
  line?: number;
  /** A short cut of the matched text, so a literal can be found in it. */
  text?: string;
}

export interface SearchMeta {
  tool: string;
  query: string;
  paths: string[];
  /** Absent on rows written before hits were recorded. */
  hits?: SearchHit[];
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

interface LocatedRead extends InlinedRead {
  /** The search that pointed here, for the listing line. */
  query: string;
  tool: string;
  /** True when the inlined window covers the entire file. */
  whole: boolean;
}

interface LocatedHit extends SearchHit {
  query: string;
  tool: string;
}

/**
 * Hit files of earlier searches that were about one of this turn's
 * literals — the query contained it, or a hit's path or matched text
 * does. Newest search first, one entry per path, so the file a search
 * for the user's exact words found outranks anything found by accident.
 */
function locateHits(searches: MemoryRow[], literals: string[]): LocatedHit[] {
  const out: LocatedHit[] = [];
  const seen = new Set<string>();
  const mentions = (text: string | undefined): boolean => {
    if (!text) return false;
    const lower = text.toLowerCase();
    return literals.some((literal) => lower.includes(literal));
  };
  for (const row of searches) {
    const meta = row.meta as SearchMeta;
    const queryHit = mentions(meta.query);
    // Rows written before hits were recorded still carry their paths.
    const hits: SearchHit[] =
      meta.hits && meta.hits.length > 0
        ? meta.hits
        : meta.paths.map((path) => ({ path }));
    for (const hit of hits) {
      if (seen.has(hit.path)) continue;
      if (!queryHit && !mentions(hit.path) && !mentions(hit.text)) continue;
      seen.add(hit.path);
      out.push({ ...hit, query: meta.query, tool: meta.tool });
    }
  }
  return out;
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
