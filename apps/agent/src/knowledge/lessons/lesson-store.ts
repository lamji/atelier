import crypto from "node:crypto";
import type { Lesson, LessonKind } from "@atelier/protocol";
import type { Db } from "../../storage/db.js";
import type { EventBus } from "../../events/event-bus.js";
import type { Embedder } from "../embeddings/embedder.js";
import type { VectorStore } from "../embeddings/vector-store.js";

const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 600; // ~150 tokens — lessons stay cheap by design
const MERGE_SIMILARITY = 0.9;

export interface SaveLessonInput {
  title: string;
  lesson: string;
  kind?: LessonKind;
  /** Symbol names this lesson is about (resolved to stable keys). */
  symbols?: string[];
  /** Workspace-relative file paths this lesson is about. */
  files?: string[];
}

interface LessonRow {
  id: number;
  title: string;
  body_md: string;
  kind: string;
  chunk_id: number | null;
  confidence: number;
  use_count: number;
  created_at: number;
}

/**
 * Episodic knowledge store. Lessons are distilled insights from past work
 * (confirmed bug fixes, gotchas, patterns), saved tiny and anchored to
 * symbols/files via the same stable keys that survive re-indexing. Their
 * text lives as 'lesson' chunks (file_id NULL, so file re-indexing never
 * touches them) and rides the normal retrieval arms — near-zero token
 * cost until a lesson is actually relevant.
 */
export class LessonStore {
  constructor(
    private db: Db,
    private bus: EventBus,
    private embedder: Embedder,
    private vectors: VectorStore
  ) {}

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM lessons").get() as { n: number }).n;
  }

  list(limit = 50): Lesson[] {
    const rows = this.db
      .prepare(
        "SELECT id, title, body_md, kind, chunk_id, confidence, use_count, " +
          "created_at FROM lessons ORDER BY created_at DESC LIMIT ?"
      )
      .all(limit) as LessonRow[];
    return rows.map((row) => this.toLesson(row));
  }

  async save(
    input: SaveLessonInput,
    taskId?: string
  ): Promise<{ lesson: Lesson; merged: boolean }> {
    const title = input.title.trim().slice(0, MAX_TITLE_CHARS);
    const body = input.lesson.trim().slice(0, MAX_BODY_CHARS);
    if (!title || !body) throw new Error("Lesson needs a title and a body");
    const kind: LessonKind = input.kind ?? "gotcha";

    const links = this.resolveLinks(input.symbols ?? [], input.files ?? []);
    const linkLabels = links.map((l) => l.label);
    const text =
      `LESSON (${kind}): ${title}\n${body}` +
      (linkLabels.length > 0 ? `\nApplies to: ${linkLabels.join(", ")}` : "");

    // Dedupe: a near-identical lesson strengthens the existing one instead
    // of bloating the store.
    const existing = await this.findSimilar(text, title);
    if (existing) {
      this.db
        .prepare(
          "UPDATE lessons SET confidence = MIN(0.95, confidence + 0.05), " +
            "last_used_at = ? WHERE id = ?"
        )
        .run(Date.now(), existing.id);
      this.addLinks(existing.id, links);
      const lesson = this.toLesson(this.rowById(existing.id));
      this.bus.publish("knowledge.lesson.saved", { lesson, merged: true }, taskId);
      return { lesson, merged: true };
    }

    const chunkInfo = this.db
      .prepare(
        "INSERT INTO chunks(file_id, symbol_id, kind, content_hash, text, token_count) " +
          "VALUES (NULL, NULL, 'lesson', ?, ?, ?)"
      )
      .run(sha1(text), text, Math.ceil(text.length / 4));
    const chunkId = Number(chunkInfo.lastInsertRowid);
    const [vec] = await this.embedder.embed([text]);
    if (vec) this.vectors.upsert(chunkId, vec);

    const info = this.db
      .prepare(
        "INSERT INTO lessons(title, body_md, kind, task_id, chunk_id, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(title, body, kind, taskId ?? null, chunkId, Date.now());
    const lessonId = Number(info.lastInsertRowid);
    this.addLinks(lessonId, links);

    const lesson = this.toLesson(this.rowById(lessonId));
    this.bus.publish("knowledge.lesson.saved", { lesson, merged: false }, taskId);
    return { lesson, merged: false };
  }

  /** Lesson chunks anchored to any of these symbol names (retrieval boost). */
  forSymbolNames(names: string[]): Array<{ lessonId: number; chunkId: number }> {
    if (names.length === 0) return [];
    const placeholders = names.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT DISTINCT l.id AS lessonId, l.chunk_id AS chunkId FROM lessons l
         JOIN lesson_links ll ON ll.lesson_id = l.id
         WHERE ll.symbol_name IN (${placeholders}) AND l.chunk_id IS NOT NULL`
      )
      .all(...names) as Array<{ lessonId: number; chunkId: number }>;
    return rows;
  }

  /** Lessons anchored to these files or their symbols (impact analysis). */
  forFiles(paths: string[]): Lesson[] {
    if (paths.length === 0) return [];
    const placeholders = paths.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT DISTINCT l.id, l.title, l.body_md, l.kind, l.chunk_id,
           l.confidence, l.use_count, l.created_at
         FROM lessons l JOIN lesson_links ll ON ll.lesson_id = l.id
         WHERE ll.file_path IN (${placeholders})
            OR ll.stable_key IN (
              SELECT s.stable_key FROM symbols s
              JOIN files f ON f.id = s.file_id
              WHERE f.path IN (${placeholders})
            )
         LIMIT 10`
      )
      .all(...paths, ...paths) as LessonRow[];
    return rows.map((row) => this.toLesson(row));
  }

  /** Called when lesson chunks actually surface in a retrieval. */
  markUsed(chunkIds: number[]): void {
    if (chunkIds.length === 0) return;
    const placeholders = chunkIds.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE lessons SET use_count = use_count + 1, last_used_at = ?
         WHERE chunk_id IN (${placeholders})`
      )
      .run(Date.now(), ...chunkIds);
  }

  /** Chunk ids of all lesson chunks (used by the retriever to classify hits). */
  lessonChunkIds(): Set<number> {
    const rows = this.db
      .prepare("SELECT chunk_id FROM lessons WHERE chunk_id IS NOT NULL")
      .all() as Array<{ chunk_id: number }>;
    return new Set(rows.map((r) => r.chunk_id));
  }

  // ---------------------------------------------------------------- private

  private resolveLinks(
    symbols: string[],
    files: string[]
  ): Array<{ stableKey: string | null; symbolName: string | null; filePath: string | null; label: string }> {
    const links: Array<{
      stableKey: string | null;
      symbolName: string | null;
      filePath: string | null;
      label: string;
    }> = [];
    const findSym = this.db.prepare(
      "SELECT s.stable_key, s.name, f.path FROM symbols s " +
        "JOIN files f ON f.id = s.file_id WHERE s.name = ? COLLATE NOCASE LIMIT 2"
    );
    for (const name of symbols.slice(0, 6)) {
      const rows = findSym.all(name.trim()) as Array<{
        stable_key: string;
        name: string;
        path: string;
      }>;
      if (rows.length === 0) {
        // Unindexed symbol: keep the name so the link activates once it exists.
        links.push({ stableKey: null, symbolName: name.trim(), filePath: null, label: name.trim() });
        continue;
      }
      for (const row of rows) {
        links.push({
          stableKey: row.stable_key,
          symbolName: row.name,
          filePath: row.path,
          label: `${row.name} (${row.path})`,
        });
      }
    }
    for (const p of files.slice(0, 6)) {
      const norm = p.trim().replaceAll("\\", "/");
      links.push({ stableKey: null, symbolName: null, filePath: norm, label: norm });
    }
    return links;
  }

  private addLinks(
    lessonId: number,
    links: Array<{ stableKey: string | null; symbolName: string | null; filePath: string | null }>
  ): void {
    const exists = this.db.prepare(
      "SELECT 1 FROM lesson_links WHERE lesson_id = ? AND " +
        "COALESCE(stable_key,'') = COALESCE(?,'') AND " +
        "COALESCE(symbol_name,'') = COALESCE(?,'') AND " +
        "COALESCE(file_path,'') = COALESCE(?,'')"
    );
    const insert = this.db.prepare(
      "INSERT INTO lesson_links(lesson_id, stable_key, symbol_name, file_path) " +
        "VALUES (?, ?, ?, ?)"
    );
    for (const link of links) {
      if (exists.get(lessonId, link.stableKey, link.symbolName, link.filePath)) {
        continue;
      }
      insert.run(lessonId, link.stableKey, link.symbolName, link.filePath);
    }
  }

  private async findSimilar(
    text: string,
    title: string
  ): Promise<{ id: number } | null> {
    if (this.embedder.available) {
      const [vec] = await this.embedder.embed([text]);
      if (vec) {
        const lessonChunks = this.lessonChunkIds();
        for (const hit of this.vectors.search(vec, 8)) {
          if (!lessonChunks.has(hit.chunkId)) continue;
          if (hit.score < MERGE_SIMILARITY) break; // results are sorted
          const row = this.db
            .prepare("SELECT id FROM lessons WHERE chunk_id = ?")
            .get(hit.chunkId) as { id: number } | undefined;
          if (row) return row;
        }
      }
    }
    // Fallback (or extra guard): exact title match.
    const byTitle = this.db
      .prepare("SELECT id FROM lessons WHERE title = ? COLLATE NOCASE")
      .get(title) as { id: number } | undefined;
    return byTitle ?? null;
  }

  private rowById(id: number): LessonRow {
    return this.db
      .prepare(
        "SELECT id, title, body_md, kind, chunk_id, confidence, use_count, " +
          "created_at FROM lessons WHERE id = ?"
      )
      .get(id) as LessonRow;
  }

  private toLesson(row: LessonRow): Lesson {
    const links = this.db
      .prepare(
        "SELECT symbol_name, file_path FROM lesson_links WHERE lesson_id = ?"
      )
      .all(row.id) as Array<{ symbol_name: string | null; file_path: string | null }>;
    const labels = new Set<string>();
    for (const link of links) {
      if (link.symbol_name) labels.add(link.symbol_name);
      else if (link.file_path) labels.add(link.file_path);
    }
    return {
      id: row.id,
      title: row.title,
      body: row.body_md,
      kind: (row.kind as Lesson["kind"]) ?? "gotcha",
      confidence: row.confidence,
      useCount: row.use_count,
      createdAt: row.created_at,
      links: [...labels],
    };
  }
}

function sha1(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}
