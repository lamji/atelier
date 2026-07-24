import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { Logger } from "pino";
import { newId } from "@atelier/shared";
import type { Db } from "../../storage/db.js";
import type { EventBus } from "../../events/event-bus.js";
import type { PathGuard } from "../../workspace/path-guard.js";
import type { WorkspaceIgnore } from "../../workspace/ignore.js";
import { ParserPool } from "../parsing/parser-pool.js";
import { isIndexable } from "../parsing/languages.js";
import type { ParsedFile } from "../parsing/parser-pool.js";
import { ImportResolver } from "../graph/resolver.js";
import { Embedder, EMBEDDER_VERSION } from "../embeddings/embedder.js";
import { VectorStore } from "../embeddings/vector-store.js";
import { buildChunks } from "../embeddings/chunker.js";

const MAX_FILE_BYTES = 1_000_000;
const FLUSH_EVERY_FILES = 25;
const EMBED_BATCH = 16;
/** Bump when extraction logic changes; forces a one-time full re-parse. */
const PARSER_VERSION = "3";

interface FileDelta {
  symbols: number;
  edges: number;
  newChunks: Array<{ id: number; text: string }>;
}

interface SymRow {
  id: number;
  stable_key: string;
}

/**
 * The incremental indexing pipeline — the knowledge engine's write path.
 * Content-hash dirty check -> persistent index_jobs queue -> per-file
 * re-parse -> symbol diff by stable_key (ids and inbound edges survive) ->
 * targeted edge re-resolution -> delta re-chunk/re-embed -> events.
 * Full scans only enqueue what actually changed; nothing ever rebuilds
 * the whole store.
 */
export class IncrementalIndexer {
  private pool = new ParserPool();
  private resolver: ImportResolver;
  private looping = false;
  /** True while a flush is embedding — the index is not current yet. */
  private flushing = false;
  private stopped = false;
  /** True after the first full scan + drain completes (CLI waits on this). */
  private ready = false;
  private pendingEmbeds: Array<{ id: number; text: string }> = [];
  private flushFiles: string[] = [];
  private flushSymbols = 0;
  private flushEdges = 0;
  private drainWaiters: Array<{ paths: Set<string> | null; resolve: () => void }> =
    [];

  constructor(
    private db: Db,
    private bus: EventBus,
    private guard: PathGuard,
    private ig: WorkspaceIgnore,
    private workspaceRoot: string,
    private embedder: Embedder,
    private vectors: VectorStore,
    private log: Logger
  ) {
    this.resolver = new ImportResolver(db);
  }

  /** Recover the persistent queue and kick a catch-up scan. */
  async start(): Promise<void> {
    this.db
      .prepare("UPDATE index_jobs SET status='queued' WHERE status='running'")
      .run();
    // Errored jobs get fresh attempts across restarts (bounded).
    this.db
      .prepare(
        "UPDATE index_jobs SET status='queued' WHERE status='error' AND attempts < 3"
      )
      .run();
    this.db
      .prepare("DELETE FROM index_jobs WHERE status='error' AND attempts >= 3")
      .run();
    this.checkEmbedderVersion();
    const parserChanged = this.checkParserVersion();
    // Resolver improvements land without re-parsing: retry every dangling
    // import/call edge against the current resolution rules.
    this.resolveDangling();
    await this.pool.init().catch((error) => {
      this.log.error({ err: error }, "tree-sitter init failed");
    });
    void this.embedder.init().then(() => {
      if (!this.embedder.available) {
        this.log.warn(
          { reason: this.embedder.failureReason },
          "embeddings unavailable; retrieval will use keyword+graph only"
        );
      }
      this.kick();
    });
    await this.indexWorkspace(parserChanged);
    // Stamp only AFTER the forced scan enqueued its jobs — jobs persist
    // in index_jobs, so a restart mid-migration resumes instead of
    // silently skipping the re-parse.
    if (parserChanged) this.stampParserVersion();
    // First pass done: block until the queue drains, then mark ready so
    // the CLI can open the browser on a warm index.
    void this.drainFor([]).then(() => {
      this.ready = true;
    });
  }

  /** Index readiness snapshot for the /atelier/ready endpoint. */
  readyStatus(): { ready: boolean; files: number; indexed: number } {
    const files = (
      this.db.prepare("SELECT COUNT(*) n FROM files").get() as { n: number }
    ).n;
    const queued = (
      this.db
        .prepare("SELECT COUNT(*) n FROM index_jobs WHERE status='queued'")
        .get() as { n: number }
    ).n;
    return { ready: this.ready, files, indexed: Math.max(0, files - queued) };
  }

  /** True when extraction logic changed since the last completed stamp. */
  private checkParserVersion(): boolean {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key='parser_version'")
      .get() as { value: string } | undefined;
    return row?.value !== PARSER_VERSION;
  }

  private stampParserVersion(): void {
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES('parser_version', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(PARSER_VERSION);
  }

  stop(): void {
    this.stopped = true;
  }

  /** If the embedding model changed, all stored vectors are invalid. */
  private checkEmbedderVersion(): void {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key='embedder_version'")
      .get() as { value: string } | undefined;
    if (row?.value !== EMBEDDER_VERSION) {
      this.db.exec("DELETE FROM chunk_embeddings");
      this.db
        .prepare(
          "INSERT INTO meta(key, value) VALUES('embedder_version', ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
        .run(EMBEDDER_VERSION);
    }
  }

  /** Scan the workspace, enqueue dirty files, drop deleted ones. */
  async indexWorkspace(force = false): Promise<string> {
    const jobId = newId("idx");
    if (force) {
      // Invalidate content hashes so processFile actually re-parses.
      this.db.exec("UPDATE files SET content_hash = NULL");
    }
    const scanned: Array<{ rel: string; mtime: number; size: number }> = [];
    await this.scanDir(this.guard.toAbsolute("."), scanned);
    this.bus.publish("knowledge.indexing.progress", {
      phase: "scan",
      done: scanned.length,
      total: scanned.length,
    });

    // Files that vanished while the agent was down.
    const known = this.db.prepare("SELECT id, path FROM files").all() as Array<{
      id: number;
      path: string;
    }>;
    const scannedSet = new Set(scanned.map((f) => f.rel.toLowerCase()));
    for (const row of known) {
      if (!scannedSet.has(row.path.toLowerCase())) this.removeFile(row.path);
    }

    const dirtyCheck = this.db.prepare(
      "SELECT mtime, size, parse_status, content_hash FROM files WHERE path = ?"
    );
    let enqueued = 0;
    for (const f of scanned) {
      const row = dirtyCheck.get(f.rel) as
        | {
            mtime: number;
            size: number;
            parse_status: string;
            content_hash: string | null;
          }
        | undefined;
      const clean =
        !force &&
        row !== undefined &&
        row.parse_status === "ok" &&
        row.content_hash !== null && // NULLed by an interrupted migration
        row.mtime === f.mtime &&
        row.size === f.size;
      if (!clean) {
        this.enqueueFile(f.rel, 0, false);
        enqueued += 1;
      }
    }
    this.log.info(
      { scanned: scanned.length, enqueued, force },
      "knowledge scan complete"
    );
    this.kick();
    return jobId;
  }

  private async scanDir(
    absDir: string,
    out: Array<{ rel: string; mtime: number; size: number }>
  ): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const isDir = entry.isDirectory();
      if (this.ig.ignoresAbsolute(abs, isDir)) continue;
      if (isDir) {
        await this.scanDir(abs, out);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = this.guard.toRelative(abs);
      if (!isIndexable(rel)) continue;
      try {
        const stat = await fs.stat(abs);
        if (stat.size > MAX_FILE_BYTES) continue;
        out.push({ rel, mtime: Math.floor(stat.mtimeMs), size: stat.size });
      } catch {
        // raced deletion
      }
    }
  }

  /** Watcher entry point; higher priority than scan backfill. */
  enqueueFile(relPath: string, priority = 10, kickNow = true): void {
    if (!isIndexable(relPath)) return;
    this.db
      .prepare("DELETE FROM index_jobs WHERE path = ? AND status = 'queued'")
      .run(relPath);
    this.db
      .prepare(
        "INSERT INTO index_jobs(kind, path, priority, status, enqueued_at) " +
          "VALUES ('file', ?, ?, 'queued', ?)"
      )
      .run(relPath, priority, Date.now());
    if (kickNow) this.kick();
  }

  /** Awaited by pipeline stage 8 so knowledge is current before summary. */
  async drainFor(paths: string[]): Promise<void> {
    const wanted =
      paths.length > 0 ? new Set(paths.map((p) => p.toLowerCase())) : null;
    // A running loop may have consumed every job and still owe the flush
    // that writes embeddings — returning here would report a current
    // index whose vectors are missing.
    if (!this.hasPendingJobs(wanted) && !this.embeddingsPending()) return;
    await new Promise<void>((resolve) => {
      this.drainWaiters.push({ paths: wanted, resolve });
      this.kick();
    });
  }

  private hasPendingJobs(paths: Set<string> | null): boolean {
    const rows = this.db
      .prepare(
        "SELECT path FROM index_jobs WHERE status IN ('queued','running')"
      )
      .all() as Array<{ path: string }>;
    if (paths === null) return rows.length > 0;
    return rows.some((r) => paths.has(r.path.toLowerCase()));
  }

  private settleDrainWaiters(): void {
    if (this.embeddingsPending()) return;
    this.drainWaiters = this.drainWaiters.filter((w) => {
      if (this.hasPendingJobs(w.paths)) return true;
      w.resolve();
      return false;
    });
  }

  /** Chunks parsed but not yet embedded, or a flush still in flight. */
  private embeddingsPending(): boolean {
    return this.pendingEmbeds.length > 0 || this.flushing;
  }

  private kick(): void {
    if (this.looping || this.stopped) return;
    this.looping = true;
    void this.loop()
      .catch((error) => this.log.error({ err: error }, "index loop crashed"))
      .finally(() => {
        this.looping = false;
        this.settleDrainWaiters();
        // Jobs can arrive while the tail of the loop (embedding backfill)
        // runs; without this re-kick they would wait for the next event.
        if (!this.stopped && this.hasPendingJobs(null)) this.kick();
      });
  }

  private async loop(): Promise<void> {
    const next = this.db.prepare(
      "SELECT id, path FROM index_jobs WHERE status='queued' " +
        "ORDER BY priority DESC, id LIMIT 1"
    );
    const total = () =>
      (
        this.db
          .prepare("SELECT COUNT(*) n FROM index_jobs WHERE status='queued'")
          .get() as { n: number }
      ).n;
    let processedSinceFlush = 0;
    let done = 0;
    const initialTotal = total();

    for (;;) {
      if (this.stopped) break;
      const job = next.get() as { id: number; path: string } | undefined;
      if (!job) break;
      this.db
        .prepare("UPDATE index_jobs SET status='running', started_at=? WHERE id=?")
        .run(Date.now(), job.id);
      try {
        const delta = await this.processFile(job.path);
        if (delta) {
          this.flushFiles.push(job.path);
          this.flushSymbols += delta.symbols;
          this.flushEdges += delta.edges;
          this.pendingEmbeds.push(...delta.newChunks);
        }
        this.db.prepare("DELETE FROM index_jobs WHERE id=?").run(job.id);
      } catch (error) {
        this.log.error({ err: error, path: job.path }, "index job failed");
        this.db
          .prepare(
            "UPDATE index_jobs SET status='error', attempts=attempts+1 WHERE id=?"
          )
          .run(job.id);
      }
      done += 1;
      if (done % 5 === 0 || total() === 0) {
        this.bus.publish("knowledge.indexing.progress", {
          phase: "parse",
          done,
          total: Math.max(initialTotal, done),
          currentPath: job.path,
        });
      }
      processedSinceFlush += 1;
      if (processedSinceFlush >= FLUSH_EVERY_FILES) {
        await this.flush();
        processedSinceFlush = 0;
      }
      // Someone is awaiting these paths (pipeline stage 8): flush first so
      // "drained" means embeddings exist too, not just symbols and chunks.
      if (this.drainWaiters.length > 0 && this.pendingEmbeds.length > 0) {
        await this.flush();
        processedSinceFlush = 0;
      }
      this.settleDrainWaiters();
      // Yield so the bridge/event loop never starves during big scans.
      await new Promise((r) => setImmediate(r));
    }

    await this.flush();
    await this.backfillEmbeddings();
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES('last_indexed_at', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(String(Date.now()));
  }

  /** Embed newly created chunks and publish the aggregated delta. */
  private async flush(): Promise<void> {
    const embeds = this.pendingEmbeds;
    this.pendingEmbeds = [];
    this.flushing = true;
    try {
      await this.embedPending(embeds);
    } finally {
      this.flushing = false;
    }
  }

  /** Embeds one flush batch and publishes the aggregated delta. */
  private async embedPending(
    embeds: Array<{ id: number; text: string }>
  ): Promise<void> {
    let embedded = 0;
    // Wait for the model instead of racing it: `available` is false until
    // init resolves, and skipping here leaves chunks unembedded — the
    // vector arm of retrieval then silently degrades to keyword+graph.
    if (embeds.length > 0) await this.embedder.init();
    if (embeds.length > 0 && this.embedder.available) {
      for (let i = 0; i < embeds.length; i += EMBED_BATCH) {
        const batch = embeds.slice(i, i + EMBED_BATCH);
        const vectors = await this.embedder.embed(batch.map((b) => b.text));
        for (let j = 0; j < vectors.length; j++) {
          this.vectors.upsert(batch[j]!.id, vectors[j]!);
          embedded += 1;
        }
        this.bus.publish("knowledge.indexing.progress", {
          phase: "embed",
          done: Math.min(i + EMBED_BATCH, embeds.length),
          total: embeds.length,
        });
      }
    }
    if (this.flushFiles.length > 0) {
      this.bus.publish("knowledge.updated", {
        files: this.flushFiles.slice(0, 50),
        symbolsDelta: this.flushSymbols,
        edgesDelta: this.flushEdges,
        embeddingsDelta: embedded,
      });
    }
    this.flushFiles = [];
    this.flushSymbols = 0;
    this.flushEdges = 0;
  }

  /** Chunks that missed embedding earlier (offline start, version bump). */
  private async backfillEmbeddings(): Promise<void> {
    await this.embedder.init();
    if (!this.embedder.available) return;
    const missing = this.db
      .prepare(
        "SELECT c.id, c.text FROM chunks c " +
          "LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id " +
          "WHERE e.chunk_id IS NULL LIMIT 5000"
      )
      .all() as Array<{ id: number; text: string }>;
    if (missing.length === 0) return;
    let doneCount = 0;
    for (let i = 0; i < missing.length; i += EMBED_BATCH) {
      if (this.stopped) return;
      const batch = missing.slice(i, i + EMBED_BATCH);
      const vectors = await this.embedder.embed(batch.map((b) => b.text));
      for (let j = 0; j < vectors.length; j++) {
        this.vectors.upsert(batch[j]!.id, vectors[j]!);
      }
      doneCount += batch.length;
      this.bus.publish("knowledge.indexing.progress", {
        phase: "embed",
        done: doneCount,
        total: missing.length,
      });
      await new Promise((r) => setImmediate(r));
    }
    if (doneCount > 0) {
      this.bus.publish("knowledge.updated", {
        files: [],
        symbolsDelta: 0,
        edgesDelta: 0,
        embeddingsDelta: doneCount,
      });
    }
  }

  /** One cheap SQL pass: re-attempt all unresolved imports + call edges. */
  private resolveDangling(): void {
    const danglingImports = this.db
      .prepare(
        "SELECT i.id, i.specifier, f.path FROM imports i " +
          "JOIN files f ON f.id = i.file_id WHERE i.resolved_file_id IS NULL"
      )
      .all() as Array<{ id: number; specifier: string; path: string }>;
    const fixImport = this.db.prepare(
      "UPDATE imports SET resolved_file_id = ? WHERE id = ?"
    );
    let importsFixed = 0;
    for (const row of danglingImports) {
      const target = this.resolver.resolve(row.path, row.specifier);
      if (target !== null) {
        fixImport.run(target, row.id);
        importsFixed += 1;
      }
    }

    // Newly resolved imports can complete unresolved call edges.
    const danglingCalls = this.db
      .prepare(
        "SELECT ce.id, ce.callee_name, s.file_id AS callerFile " +
          "FROM call_edges ce JOIN symbols s ON s.id = ce.caller_symbol_id " +
          "WHERE ce.callee_symbol_id IS NULL"
      )
      .all() as Array<{ id: number; callee_name: string; callerFile: number }>;
    const importsOf = this.db.prepare(
      "SELECT resolved_file_id, imported_names, specifier FROM imports " +
        "WHERE file_id = ? AND resolved_file_id IS NOT NULL"
    );
    const findSym = this.db.prepare(
      "SELECT id FROM symbols WHERE file_id = ? AND name = ? LIMIT 1"
    );
    const fixCall = this.db.prepare(
      "UPDATE call_edges SET callee_symbol_id = ?, callee_module_hint = ?, " +
        "confidence = 0.75 WHERE id = ?"
    );
    const importCache = new Map<
      number,
      Array<{ fileId: number; specifier: string; names: string[] }>
    >();
    let callsFixed = 0;
    for (const call of danglingCalls) {
      let imports = importCache.get(call.callerFile);
      if (!imports) {
        imports = (
          importsOf.all(call.callerFile) as Array<{
            resolved_file_id: number;
            imported_names: string | null;
            specifier: string;
          }>
        ).map((r) => ({
          fileId: r.resolved_file_id,
          specifier: r.specifier,
          names: safeNames(r.imported_names),
        }));
        importCache.set(call.callerFile, imports);
      }
      for (const imp of imports) {
        if (!imp.names.includes(call.callee_name)) continue;
        const hit = findSym.get(imp.fileId, call.callee_name) as
          | { id: number }
          | undefined;
        if (hit) {
          fixCall.run(hit.id, imp.specifier, call.id);
          callsFixed += 1;
          break;
        }
      }
    }

    if (importsFixed > 0 || callsFixed > 0) {
      this.log.info(
        { importsFixed, callsFixed },
        "healed dangling imports/call edges"
      );
      this.bus.publish("knowledge.updated", {
        files: [],
        symbolsDelta: 0,
        edgesDelta: 0,
        embeddingsDelta: 0,
      });
    }
  }

  // ---------------------------------------------------------------- files

  private removeFile(relPath: string): void {
    const row = this.db
      .prepare("SELECT id FROM files WHERE path = ?")
      .get(relPath) as { id: number } | undefined;
    if (!row) return;
    const chunkIds = (
      this.db
        .prepare("SELECT id FROM chunks WHERE file_id = ?")
        .all(row.id) as Array<{ id: number }>
    ).map((c) => c.id);
    this.db.transaction(() => {
      // Break non-cascading references before the delete.
      this.db
        .prepare(
          "UPDATE imports SET resolved_file_id = NULL WHERE resolved_file_id = ?"
        )
        .run(row.id);
      this.db
        .prepare("UPDATE symbols SET parent_symbol_id = NULL WHERE file_id = ?")
        .run(row.id);
      this.db.prepare("DELETE FROM files WHERE id = ?").run(row.id);
    })();
    this.vectors.forget(chunkIds);
    this.flushFiles.push(relPath);
  }

  private async processFile(relPath: string): Promise<FileDelta | null> {
    const abs = this.guard.toAbsolute(relPath);
    let source: string;
    let stat: { mtimeMs: number; size: number };
    try {
      const s = await fs.stat(abs);
      if (s.size > MAX_FILE_BYTES) return null;
      source = await fs.readFile(abs, "utf8");
      stat = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      this.removeFile(relPath);
      return { symbols: 0, edges: 0, newChunks: [] };
    }

    const hash = sha1(source);
    const existing = this.db
      .prepare("SELECT id, content_hash, parse_status FROM files WHERE path = ?")
      .get(relPath) as
      | { id: number; content_hash: string | null; parse_status: string }
      | undefined;
    if (existing?.content_hash === hash && existing.parse_status === "ok") {
      // Content identical (e.g. mtime-only touch): just refresh metadata.
      this.db
        .prepare("UPDATE files SET mtime = ?, size = ? WHERE id = ?")
        .run(Math.floor(stat.mtimeMs), stat.size, existing.id);
      return null;
    }

    const parsed = await this.pool.parseFile(relPath, source);
    const fileId = this.upsertFileRow(relPath, parsed, hash, stat);
    if (!parsed) return null;

    const delta: FileDelta = { symbols: 0, edges: 0, newChunks: [] };
    const symbolIds = this.diffSymbols(fileId, relPath, parsed, delta);
    this.rewriteImports(fileId, relPath, parsed);
    this.rewriteExports(fileId, parsed, symbolIds);
    delta.edges += this.rewriteCallEdges(fileId, parsed, symbolIds);
    this.reresolveInbound(fileId, relPath);
    this.rewriteChunks(fileId, parsed, source, symbolIds, delta);
    this.db
      .prepare(
        "UPDATE features SET status='stale' WHERE status='fresh' AND id IN " +
          "(SELECT feature_id FROM feature_files WHERE file_id = ?)"
      )
      .run(fileId);
    return delta;
  }

  private upsertFileRow(
    relPath: string,
    parsed: ParsedFile | null,
    hash: string,
    stat: { mtimeMs: number; size: number }
  ): number {
    const status = parsed ? "ok" : "skipped";
    this.db
      .prepare(
        "INSERT INTO files(path, lang, size, mtime, content_hash, parse_status, parsed_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(path) DO UPDATE SET lang=excluded.lang, size=excluded.size, " +
          "mtime=excluded.mtime, content_hash=excluded.content_hash, " +
          "parse_status=excluded.parse_status, parsed_at=excluded.parsed_at, error=NULL"
      )
      .run(
        relPath,
        parsed?.lang ?? null,
        stat.size,
        Math.floor(stat.mtimeMs),
        hash,
        status,
        Date.now()
      );
    return (
      this.db.prepare("SELECT id FROM files WHERE path = ?").get(relPath) as {
        id: number;
      }
    ).id;
  }

  /**
   * Diff parsed symbols against stored rows by stable_key so unchanged
   * symbols keep their ids — inbound call edges and unchanged chunks
   * survive the re-index untouched.
   */
  private diffSymbols(
    fileId: number,
    relPath: string,
    parsed: ParsedFile,
    delta: FileDelta
  ): Map<string, number> {
    const old = this.db
      .prepare("SELECT id, stable_key FROM symbols WHERE file_id = ?")
      .all(fileId) as SymRow[];
    const oldByKey = new Map(old.map((r) => [r.stable_key, r.id]));
    const idByQualifiedName = new Map<string, number>();
    const usedKeys = new Set<string>();

    const update = this.db.prepare(
      "UPDATE symbols SET name=?, kind=?, signature=?, start_row=?, start_col=?, " +
        "end_row=?, end_col=?, doc_comment=? WHERE id=?"
    );
    const insert = this.db.prepare(
      "INSERT INTO symbols(file_id, name, kind, signature, parent_symbol_id, " +
        "start_row, start_col, end_row, end_col, doc_comment, stable_key) " +
        "VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)"
    );

    this.db.transaction(() => {
      const keyCounts = new Map<string, number>();
      for (const sym of parsed.symbols) {
        const baseKey = `${relPath}|${sym.kind}|${sym.qualifiedName}`;
        const n = keyCounts.get(baseKey) ?? 0;
        keyCounts.set(baseKey, n + 1);
        const key = sha1(n === 0 ? baseKey : `${baseKey}#${n}`);
        usedKeys.add(key);
        const existingId = oldByKey.get(key);
        if (existingId !== undefined) {
          update.run(
            sym.name,
            sym.kind,
            sym.signature,
            sym.startRow,
            sym.startCol,
            sym.endRow,
            sym.endCol,
            sym.doc ?? null,
            existingId
          );
          idByQualifiedName.set(sym.qualifiedName, existingId);
        } else {
          const info = insert.run(
            fileId,
            sym.name,
            sym.kind,
            sym.signature,
            sym.startRow,
            sym.startCol,
            sym.endRow,
            sym.endCol,
            sym.doc ?? null,
            key
          );
          idByQualifiedName.set(sym.qualifiedName, Number(info.lastInsertRowid));
          delta.symbols += 1;
        }
      }

      // Deletions: break child parent refs first (FK is NO ACTION).
      const goneIds = old
        .filter((r) => !usedKeys.has(r.stable_key))
        .map((r) => r.id);
      if (goneIds.length > 0) {
        const placeholders = goneIds.map(() => "?").join(",");
        this.db
          .prepare(
            `UPDATE symbols SET parent_symbol_id = NULL WHERE parent_symbol_id IN (${placeholders})`
          )
          .run(...goneIds);
        this.db
          .prepare(`DELETE FROM symbols WHERE id IN (${placeholders})`)
          .run(...goneIds);
        delta.symbols -= goneIds.length;
      }

      // Parent linking (second pass, ids now known).
      const setParent = this.db.prepare(
        "UPDATE symbols SET parent_symbol_id = ? WHERE id = ?"
      );
      for (const sym of parsed.symbols) {
        if (!sym.parentQualifiedName) continue;
        const childId = idByQualifiedName.get(sym.qualifiedName);
        const parentId = idByQualifiedName.get(sym.parentQualifiedName);
        if (childId !== undefined && parentId !== undefined) {
          setParent.run(parentId, childId);
        }
      }
    })();

    return idByQualifiedName;
  }

  private rewriteImports(
    fileId: number,
    relPath: string,
    parsed: ParsedFile
  ): void {
    const insert = this.db.prepare(
      "INSERT INTO imports(file_id, specifier, resolved_file_id, imported_names, is_type_only) " +
        "VALUES (?, ?, ?, ?, ?)"
    );
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM imports WHERE file_id = ?").run(fileId);
      for (const imp of parsed.imports) {
        insert.run(
          fileId,
          imp.specifier,
          this.resolver.resolve(relPath, imp.specifier),
          JSON.stringify(imp.names),
          imp.typeOnly ? 1 : 0
        );
      }
    })();
  }

  private rewriteExports(
    fileId: number,
    parsed: ParsedFile,
    symbolIds: Map<string, number>
  ): void {
    const insert = this.db.prepare(
      "INSERT INTO exports(file_id, symbol_id, exported_name, is_default, re_export_from) " +
        "VALUES (?, ?, ?, ?, ?)"
    );
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM exports WHERE file_id = ?").run(fileId);
      const seen = new Set<string>();
      for (const exp of parsed.exports) {
        const dedupe = `${exp.exportedName}|${exp.reExportFrom ?? ""}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        insert.run(
          fileId,
          exp.localName ? (symbolIds.get(exp.localName) ?? null) : null,
          exp.exportedName,
          exp.isDefault ? 1 : 0,
          exp.reExportFrom ?? null
        );
      }
      // Exported declarations (export const/function/class) that produced
      // symbols but no export_clause record.
      for (const sym of parsed.symbols) {
        if (!sym.exported || sym.parentQualifiedName) continue;
        if (seen.has(`${sym.name}|`)) continue;
        seen.add(`${sym.name}|`);
        insert.run(
          fileId,
          symbolIds.get(sym.qualifiedName) ?? null,
          sym.name,
          0,
          null
        );
      }
    })();
  }

  /** Rewrite outgoing call edges for this file, resolving callees. */
  private rewriteCallEdges(
    fileId: number,
    parsed: ParsedFile,
    symbolIds: Map<string, number>
  ): number {
    // importedName -> {fileId, specifier}
    const importedFrom = new Map<string, { fileId: number; specifier: string }>();
    const importRows = this.db
      .prepare(
        "SELECT specifier, resolved_file_id, imported_names FROM imports " +
          "WHERE file_id = ? AND resolved_file_id IS NOT NULL"
      )
      .all(fileId) as Array<{
      specifier: string;
      resolved_file_id: number;
      imported_names: string | null;
    }>;
    for (const row of importRows) {
      for (const name of safeNames(row.imported_names)) {
        importedFrom.set(name, {
          fileId: row.resolved_file_id,
          specifier: row.specifier,
        });
      }
    }

    const localByName = new Map<string, number>();
    for (const sym of parsed.symbols) {
      const id = symbolIds.get(sym.qualifiedName);
      if (id !== undefined && !localByName.has(sym.name)) {
        localByName.set(sym.name, id);
      }
    }

    const findInFile = this.db.prepare(
      "SELECT id FROM symbols WHERE file_id = ? AND name = ? LIMIT 1"
    );
    const findGlobal = this.db.prepare(
      "SELECT id FROM symbols WHERE name = ? AND file_id != ? LIMIT 2"
    );
    const insert = this.db.prepare(
      "INSERT INTO call_edges(caller_symbol_id, callee_symbol_id, callee_name, " +
        "callee_module_hint, site_row, confidence) VALUES (?, ?, ?, ?, ?, ?)"
    );

    let count = 0;
    this.db.transaction(() => {
      const ids = [...symbolIds.values()];
      if (ids.length > 0) {
        const placeholders = ids.map(() => "?").join(",");
        this.db
          .prepare(
            `DELETE FROM call_edges WHERE caller_symbol_id IN (${placeholders})`
          )
          .run(...ids);
      }
      for (const sym of parsed.symbols) {
        const callerId = symbolIds.get(sym.qualifiedName);
        if (callerId === undefined) continue;
        for (const call of sym.calls) {
          if (call.name === sym.name) continue; // self-recursion noise
          let calleeId: number | null = null;
          let hint: string | null = null;
          let confidence = 0.3;
          const local = localByName.get(call.name);
          if (local !== undefined && local !== callerId) {
            calleeId = local;
            confidence = 0.9;
          } else {
            const imp = importedFrom.get(call.name);
            if (imp) {
              const hit = findInFile.get(imp.fileId, call.name) as
                | { id: number }
                | undefined;
              calleeId = hit?.id ?? null;
              hint = imp.specifier;
              confidence = hit ? 0.8 : 0.4;
            } else {
              const globals = findGlobal.all(call.name, fileId) as Array<{
                id: number;
              }>;
              if (globals.length === 1) {
                calleeId = globals[0]!.id;
                confidence = 0.5;
              }
            }
          }
          insert.run(callerId, calleeId, call.name, hint, call.row, confidence);
          count += 1;
        }
      }
    })();
    return count;
  }

  /**
   * A file's (re)appearance can complete other files' dangling references:
   * unresolved imports that point here, and unresolved call edges from
   * files importing this one.
   */
  private reresolveInbound(fileId: number, relPath: string): void {
    const dangling = this.db
      .prepare(
        "SELECT i.id, i.specifier, f.path AS importer FROM imports i " +
          "JOIN files f ON f.id = i.file_id WHERE i.resolved_file_id IS NULL"
      )
      .all() as Array<{ id: number; specifier: string; importer: string }>;
    const fix = this.db.prepare(
      "UPDATE imports SET resolved_file_id = ? WHERE id = ?"
    );
    for (const row of dangling) {
      if (this.resolver.couldResolveTo(row.importer, row.specifier, relPath)) {
        fix.run(fileId, row.id);
      }
    }

    const unresolvedCalls = this.db
      .prepare(
        "SELECT DISTINCT ce.id, ce.callee_name FROM call_edges ce " +
          "JOIN symbols s ON s.id = ce.caller_symbol_id " +
          "JOIN imports i ON i.file_id = s.file_id AND i.resolved_file_id = ? " +
          "WHERE ce.callee_symbol_id IS NULL"
      )
      .all(fileId) as Array<{ id: number; callee_name: string }>;
    if (unresolvedCalls.length === 0) return;
    const findHere = this.db.prepare(
      "SELECT id FROM symbols WHERE file_id = ? AND name = ? LIMIT 1"
    );
    const fixEdge = this.db.prepare(
      "UPDATE call_edges SET callee_symbol_id = ?, confidence = 0.7 WHERE id = ?"
    );
    for (const edge of unresolvedCalls) {
      const hit = findHere.get(fileId, edge.callee_name) as
        | { id: number }
        | undefined;
      if (hit) fixEdge.run(hit.id, edge.id);
    }
  }

  /** Re-chunk the file; unchanged chunk hashes keep their embeddings. */
  private rewriteChunks(
    fileId: number,
    parsed: ParsedFile,
    source: string,
    symbolIds: Map<string, number>,
    delta: FileDelta
  ): void {
    const built = buildChunks(parsed, source);
    const old = this.db
      .prepare("SELECT id, content_hash FROM chunks WHERE file_id = ?")
      .all(fileId) as Array<{ id: number; content_hash: string }>;
    const oldByHash = new Map<string, number[]>();
    for (const row of old) {
      const list = oldByHash.get(row.content_hash) ?? [];
      list.push(row.id);
      oldByHash.set(row.content_hash, list);
    }

    const insert = this.db.prepare(
      "INSERT INTO chunks(file_id, symbol_id, kind, content_hash, text, " +
        "token_count, start_row, end_row) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const staleIds: number[] = [];
    this.db.transaction(() => {
      for (const chunk of built) {
        const hash = sha1(chunk.text);
        const reuse = oldByHash.get(hash);
        if (reuse && reuse.length > 0) {
          reuse.shift(); // identical chunk survives, embedding intact
          continue;
        }
        const symbolId = chunk.symbolQualifiedName
          ? (symbolIds.get(chunk.symbolQualifiedName) ?? null)
          : null;
        const info = insert.run(
          fileId,
          symbolId,
          chunk.kind,
          hash,
          chunk.text,
          chunk.tokenCount,
          chunk.startRow ?? null,
          chunk.endRow ?? null
        );
        delta.newChunks.push({
          id: Number(info.lastInsertRowid),
          text: chunk.text,
        });
      }
      for (const ids of oldByHash.values()) staleIds.push(...ids);
      if (staleIds.length > 0) {
        const placeholders = staleIds.map(() => "?").join(",");
        this.db
          .prepare(`DELETE FROM chunks WHERE id IN (${placeholders})`)
          .run(...staleIds);
      }
    })();
    this.vectors.forget(staleIds);
  }
}

function sha1(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function safeNames(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((n): n is string => typeof n === "string")
      : [];
  } catch {
    return [];
  }
}
