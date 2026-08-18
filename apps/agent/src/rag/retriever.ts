import type {
  Feature,
  GraphNode,
  RetrievalResult,
  RetrievedChunk,
} from "@atelier/protocol";
import { CHUNKS_FTS, hasChunkSearchIndex, type Db } from "../storage/db.js";
import type { Embedder } from "../knowledge/embeddings/embedder.js";
import type { VectorStore } from "../knowledge/embeddings/vector-store.js";
import type { KnowledgeQuery } from "../knowledge/query/knowledge-query.js";
import type { LessonStore } from "../knowledge/lessons/lesson-store.js";

/**
 * Chunk text carried back with each hit. Deliberately generous: callers
 * that only need a teaser clip it themselves, while the execute stage
 * feeds the top hits to the model as code — a 360-char preview says a
 * file exists without saying what it does.
 */
const PREVIEW_CHARS = 1200;

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "in", "on", "of", "to", "for",
  "and", "or", "what", "where", "which", "how", "does", "do", "did",
  "this", "that", "with", "from", "how", "when", "why", "can", "handled",
  "handles", "file", "files", "code", "codebase", "there",
]);

interface ChunkRow {
  id: number;
  path: string;
  kind: string;
  text: string;
  start_row: number | null;
  end_row: number | null;
  symbol_id: number | null;
  token_count: number | null;
  content_hash: string | null;
  conversation_id: string | null;
  global_alias: string | null;
}

/**
 * Hybrid retrieval: vector top-k over chunk embeddings + keyword scan +
 * symbol-name graph matches + fresh feature summaries, merged and ranked.
 * Degrades gracefully — with no embeddings it is keyword+graph only.
 */
export class Retriever {
  /** Whether the FTS index exists; probed once, then remembered. */
  private useFts: boolean | null = null;

  constructor(
    private db: Db,
    private embedder: Embedder,
    private vectors: VectorStore,
    private knowledge: KnowledgeQuery,
    private lessons: LessonStore
  ) {}

  async retrieve(
    query: string,
    k = 12,
    filters?: {
      pathGlob?: string;
      kinds?: string[];
      conversationId?: string;
      includeGlobalSessions?: boolean;
    }
  ): Promise<RetrievalResult> {
    const arms: string[] = [];
    const scores = new Map<number, { vec: number; kw: number; sym: number }>();
    const bump = (id: number, arm: "vec" | "kw" | "sym", score: number) => {
      const entry = scores.get(id) ?? { vec: 0, kw: 0, sym: 0 };
      entry[arm] = Math.max(entry[arm], score);
      scores.set(id, entry);
    };
    const terms = extractTerms(query);
    let qvec: Float32Array | undefined;

    // Arm 1: vector similarity.
    if (this.embedder.available && this.hasEmbeddings()) {
      [qvec] = await this.embedder.embed([query]);
      if (qvec) {
        const hits = this.vectors.search(qvec, k * 3);
        if (hits.length > 0) {
          arms.push("vector");
          for (const hit of hits) bump(hit.chunkId, "vec", hit.score);
        }
      }
    }

    // Arm 1b: provider-neutral session memory for this conversation. This is
    // intentionally conversation-scoped so another chat's transcript never
    // leaks into the current model context.
    if (filters?.conversationId) {
      const hits = this.sessionMemoryHits(filters.conversationId, terms, qvec);
      if (hits.length > 0) {
        arms.push("session-memory");
        for (const hit of hits) {
          if (hit.vec > 0) bump(hit.chunkId, "vec", hit.vec);
          if (hit.kw > 0) bump(hit.chunkId, "kw", hit.kw);
        }
      }
    }

    // Arm 1c: only memories the user explicitly promoted, and only while the
    // experimental setting is on. This is separate from local session recall.
    if (filters?.includeGlobalSessions) {
      const hits = this.globalSessionHits(terms, qvec);
      if (hits.length > 0) {
        arms.push("global-session-memory");
        for (const hit of hits) {
          if (hit.vec > 0) bump(hit.chunkId, "vec", hit.vec);
          if (hit.kw > 0) bump(hit.chunkId, "kw", hit.kw);
        }
      }
    }

    // Arm 2: keyword occurrence over chunk text.
    if (terms.length > 0) {
      const hitCounts = new Map<number, number>();
      for (const term of terms) {
        const rows = this.keywordRows(
          term,
          filters?.conversationId,
          filters?.includeGlobalSessions ?? false
        );
        for (const row of rows) {
          hitCounts.set(row.id, (hitCounts.get(row.id) ?? 0) + 1);
        }
      }
      if (hitCounts.size > 0) {
        arms.push("keyword");
        for (const [id, hits] of hitCounts) {
          bump(id, "kw", hits / terms.length);
        }
      }
    }

    // Arm 3: symbol-name matches -> graph nodes + their chunks.
    const graphNodes: GraphNode[] = [];
    const identifiers = extractIdentifiers(query);
    const seenSymbols = new Set<number>();
    const matchedSymbolNames = new Set<string>();
    for (const ident of identifiers.slice(0, 5)) {
      for (const sym of this.knowledge.search(ident, 3)) {
        if (seenSymbols.has(sym.id)) continue;
        seenSymbols.add(sym.id);
        matchedSymbolNames.add(sym.name);
        graphNodes.push({
          id: `sym:${sym.id}`,
          label: sym.name,
          kind: sym.kind,
          path: sym.path,
        });
        const chunkRows = this.db
          .prepare(
            "SELECT id FROM chunks WHERE symbol_id = ? " +
              "OR (kind = 'doc' AND file_id = " +
              "(SELECT file_id FROM symbols WHERE id = ?)) LIMIT 4"
          )
          .all(sym.id, sym.id) as Array<{ id: number }>;
        const exact =
          sym.name.toLowerCase() === query.trim().toLowerCase() ? 1 : 0.7;
        for (const row of chunkRows) bump(row.id, "sym", exact);
      }
    }
    if (graphNodes.length > 0) arms.push("symbols");

    // Arm 3b: lessons anchored to matched symbols surface with priority —
    // a past confirmed fix outranks similarity noise.
    const anchored = this.lessons.forSymbolNames([...matchedSymbolNames]);
    if (anchored.length > 0) {
      arms.push("lessons");
      for (const hit of anchored) bump(hit.chunkId, "sym", 1);
    }

    // Arm 4: feature summaries (populated from Phase 7 on).
    const features = this.matchFeatures(terms);
    if (features.length > 0) arms.push("features");

    // Merge, filter, rank. Arms are min-max normalized first so one arm's
    // score scale (e.g. raw cosine vs hit ratio) cannot drown the others;
    // the 0.55/0.30/0.15 weights then mean what they say.
    normalizeArms(scores);
    const combined = [...scores.entries()].map(([id, s]) => ({
      id,
      s,
      score: 0.55 * s.vec + 0.3 * s.kw + 0.15 * s.sym,
    }));
    combined.sort((a, b) => b.score - a.score);

    const chunks: RetrievedChunk[] = [];
    const pathRe = filters?.pathGlob ? globToRegex(filters.pathGlob) : null;
    // LEFT JOIN: lesson/feature chunks have no file (file_id NULL by
    // design, so re-indexing never wipes them); path falls back to kind.
    const loadChunk = this.db.prepare(
      "SELECT c.id, COALESCE(f.path, " +
        "CASE WHEN c.kind = 'session-memory' AND sc.conversation_id IS NOT NULL " +
        "THEN 'session:' || sc.conversation_id " +
        "WHEN c.kind = 'global-session-memory' AND gs.alias IS NOT NULL " +
        "THEN 'global-session:' || gs.alias ELSE c.kind END) AS path, " +
        "c.kind, c.text, " +
        "c.start_row, c.end_row, c.symbol_id, c.token_count, c.content_hash " +
        ", sc.conversation_id, gs.alias AS global_alias " +
        "FROM chunks c LEFT JOIN files f ON f.id = c.file_id " +
        "LEFT JOIN session_chunks sc ON sc.chunk_id = c.id " +
        "LEFT JOIN global_session_chunks gsc ON gsc.chunk_id = c.id " +
        "LEFT JOIN global_sessions gs ON gs.id = gsc.global_session_id " +
        "WHERE c.id = ?"
    );
    const fileless = (kind: string) =>
      kind === "lesson" ||
      kind === "feature-summary" ||
      kind === "session-memory" ||
      kind === "global-session-memory";
    const usedLessonChunks: number[] = [];
    for (const hit of combined) {
      if (chunks.length >= k) break;
      const row = loadChunk.get(hit.id) as ChunkRow | undefined;
      if (!row) continue;
      if (row.kind === "session-memory") {
        if (!filters?.conversationId) continue;
        if (row.conversation_id !== filters.conversationId) continue;
      }
      if (row.kind === "global-session-memory" && !filters?.includeGlobalSessions) {
        continue;
      }
      if (pathRe && !fileless(row.kind) && !pathRe.test(row.path)) continue;
      if (filters?.kinds && !filters.kinds.includes(row.kind)) continue;
      if (row.kind === "lesson") usedLessonChunks.push(row.id);
      chunks.push({
        id: row.id,
        path: row.path,
        kind: normalizeKind(row.kind),
        score: Number(hit.score.toFixed(4)),
        preview:
          row.text.length > PREVIEW_CHARS
            ? row.text.slice(0, PREVIEW_CHARS) + "…"
            : row.text,
        startRow: row.start_row ?? undefined,
        endRow: row.end_row ?? undefined,
        symbolId: row.symbol_id ?? undefined,
        tokenCount:
          row.token_count && row.token_count > 0
            ? row.token_count
            : Math.ceil(row.text.length / 4),
        contentHash: row.content_hash ?? undefined,
        arms: {
          vec: Number(hit.s.vec.toFixed(4)),
          kw: Number(hit.s.kw.toFixed(4)),
          sym: Number(hit.s.sym.toFixed(4)),
        },
      });
    }
    this.lessons.markUsed(usedLessonChunks);

    const strategy =
      arms.length > 0 ? `hybrid(${arms.join("+")})` : "empty(no-index)";
    return { strategy, chunks, graphNodes, features };
  }

  /**
   * Whether the vector arm has anything to search.
   *
   * This ran a `COUNT(*)` over every embedding on EVERY retrieve. Only a
   * `true` answer is cached: the count is expensive exactly when the table
   * is large, which is when it answers true, and embeddings never leave
   * except at boot (the embedder-version wipe, a fresh process with an
   * empty cache). A `false` re-probes each time — the count on an empty
   * table is instant, and it is also the answer that can silently change
   * underneath us: summary and lesson embeds write vectors WITHOUT a
   * knowledge.updated event, so a stored false would disable the vector
   * arm for the rest of the process.
   */
  private embeddingsPresent = false;

  private hasEmbeddings(): boolean {
    if (!this.embeddingsPresent) {
      const row = this.db
        .prepare("SELECT COUNT(*) n FROM chunk_embeddings")
        .get() as { n: number };
      this.embeddingsPresent = row.n > 0;
    }
    return this.embeddingsPresent;
  }

  private keywordRows(
    term: string,
    conversationId?: string,
    includeGlobalSessions = false
  ): Array<{ id: number }> {
    if (this.useFts === null) this.useFts = hasChunkSearchIndex(this.db);
    // A trigram index cannot answer a query shorter than a trigram, and it
    // returns nothing rather than erroring — silently losing the term. In
    // practice `extractTerms` never emits one, but the scan is correct for
    // any length and a one-line guard is cheaper than that coupling.
    if (this.useFts && term.length >= 3) {
      try {
        return this.ftsKeywordRows(term, conversationId, includeGlobalSessions);
      } catch {
        // A malformed MATCH expression should cost this one term, not the
        // whole retrieval; the scan below still answers it correctly.
        this.useFts = false;
      }
    }
    return this.likeKeywordRows(term, conversationId, includeGlobalSessions);
  }

  /**
   * The indexed path. The trigram tokenizer makes a MATCH on a bare term
   * mean the same thing the LIKE did — the term appearing anywhere in the
   * chunk, including inside an identifier — so this is a speed change, not
   * a behaviour change. The term is double-quoted because FTS5 reads bare
   * input as a query language, where `and`, `*` and `-` are operators.
   */
  private ftsKeywordRows(
    term: string,
    conversationId?: string,
    includeGlobalSessions = false
  ): Array<{ id: number }> {
    const match = `"${term.replace(/"/g, '""')}"`;
    if (conversationId) {
      return this.db
        .prepare(
          `SELECT c.id FROM ${CHUNKS_FTS} f ` +
            "JOIN chunks c ON c.id = f.rowid " +
            "LEFT JOIN session_chunks sc ON sc.chunk_id = c.id " +
            `WHERE ${CHUNKS_FTS} MATCH ? AND ` +
            "(c.kind != 'session-memory' OR sc.conversation_id = ?) AND " +
            "(c.kind != 'global-session-memory' OR ? = 1) LIMIT 300"
        )
        .all(match, conversationId, includeGlobalSessions ? 1 : 0) as Array<{ id: number }>;
    }
    return this.db
      .prepare(
        `SELECT c.id FROM ${CHUNKS_FTS} f ` +
          "JOIN chunks c ON c.id = f.rowid " +
          `WHERE ${CHUNKS_FTS} MATCH ? ` +
          "AND c.kind != 'session-memory' " +
          "AND (c.kind != 'global-session-memory' OR ? = 1) LIMIT 300"
      )
      .all(match, includeGlobalSessions ? 1 : 0) as Array<{ id: number }>;
  }

  /** The scan. Correct everywhere, fast nowhere — the fallback. */
  private likeKeywordRows(
    term: string,
    conversationId?: string,
    includeGlobalSessions = false
  ): Array<{ id: number }> {
    const like = `%${term}%`;
    if (conversationId) {
      return this.db
        .prepare(
          "SELECT c.id FROM chunks c " +
            "LEFT JOIN session_chunks sc ON sc.chunk_id = c.id " +
            "WHERE lower(c.text) LIKE ? AND " +
            "(c.kind != 'session-memory' OR sc.conversation_id = ?) AND " +
            "(c.kind != 'global-session-memory' OR ? = 1) LIMIT 300"
        )
        .all(like, conversationId, includeGlobalSessions ? 1 : 0) as Array<{ id: number }>;
    }
    return this.db
      .prepare(
        "SELECT id FROM chunks WHERE lower(text) LIKE ? " +
          "AND kind != 'session-memory' " +
          "AND (kind != 'global-session-memory' OR ? = 1) LIMIT 300"
      )
      .all(like, includeGlobalSessions ? 1 : 0) as Array<{ id: number }>;
  }

  private globalSessionHits(
    terms: string[],
    qvec?: Float32Array
  ): Array<{ chunkId: number; vec: number; kw: number }> {
    const rows = this.db
      .prepare(
        "SELECT c.id, c.text, e.embedding FROM global_session_chunks gsc " +
          "JOIN chunks c ON c.id = gsc.chunk_id " +
          "LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id " +
          "ORDER BY gsc.updated_at DESC, gsc.ord LIMIT 400"
      )
      .all() as Array<{ id: number; text: string; embedding: Buffer | null }>;
    const hits = rows
      .map((row) => {
        const hay = row.text.toLowerCase();
        const kw = terms.length
          ? terms.filter((term) => hay.includes(term)).length / terms.length
          : 0;
        const vec = qvec && row.embedding ? cosine(qvec, row.embedding) : 0;
        return { chunkId: row.id, vec, kw };
      })
      .filter((hit) => hit.vec > 0.2 || hit.kw > 0);
    hits.sort((a, b) => Math.max(b.vec, b.kw) - Math.max(a.vec, a.kw));
    return hits.slice(0, 12);
  }

  private sessionMemoryHits(
    conversationId: string,
    terms: string[],
    qvec?: Float32Array
  ): Array<{ chunkId: number; vec: number; kw: number }> {
    // Every chunk this conversation produced — the per-task overview AND the
    // per-unit details — so a query can match one step of a long session.
    const rows = this.db
      .prepare(
        "SELECT c.id, c.text, e.embedding FROM session_chunks sc " +
          "JOIN chunks c ON c.id = sc.chunk_id " +
          "LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id " +
          "WHERE sc.conversation_id = ? ORDER BY sc.created_at DESC, sc.ord LIMIT 240"
      )
      .all(conversationId) as Array<{
      id: number;
      text: string;
      embedding: Buffer | null;
    }>;
    const hits = rows
      .map((row) => {
        const hay = row.text.toLowerCase();
        const kw =
          terms.length > 0
            ? terms.filter((term) => hay.includes(term)).length / terms.length
            : 0;
        const vec = qvec && row.embedding ? cosine(qvec, row.embedding) : 0;
        return { chunkId: row.id, vec, kw };
      })
      .filter((hit) => hit.vec > 0.2 || hit.kw > 0);
    hits.sort((a, b) => Math.max(b.vec, b.kw) - Math.max(a.vec, a.kw));
    return hits.slice(0, 8);
  }

  private matchFeatures(terms: string[]): Feature[] {
    if (terms.length === 0) return [];
    const rows = this.db
      .prepare(
        "SELECT id, name, slug, summary, detail_md, status, updated_at " +
          "FROM features WHERE status != 'building' LIMIT 100"
      )
      .all() as Array<{
      id: number;
      name: string;
      slug: string;
      summary: string;
      detail_md: string | null;
      status: string;
      updated_at: number;
    }>;
    // Two hits, one of them in the name. `terms.some(...)` over name AND
    // summary let a single common word ("issue", "data", "page") match a
    // feature that had nothing to do with the request — and a matched
    // feature is printed to the model as files worth working on, so a
    // loose match reads to it as direction.
    const matched = rows.filter((f) => {
      const name = f.name.toLowerCase();
      const summary = f.summary.toLowerCase();
      const nameHits = terms.filter((t) => name.includes(t)).length;
      if (nameHits === 0) return false;
      const summaryHits = terms.filter((t) => summary.includes(t)).length;
      return nameHits + summaryHits >= 2;
    });
    const filesFor = this.db.prepare(
      "SELECT f.path FROM feature_files ff JOIN files f ON f.id = ff.file_id " +
        "WHERE ff.feature_id = ? ORDER BY ff.weight DESC, f.path LIMIT 20"
    );
    return matched.slice(0, 5).map((f) => ({
      id: f.id,
      name: f.name,
      slug: f.slug,
      summary: f.summary,
      detailMd: f.detail_md ?? undefined,
      status: f.status as Feature["status"],
      updatedAt: f.updated_at,
      files: (filesFor.all(f.id) as Array<{ path: string }>).map(
        (row) => row.path
      ),
    }));
  }
}

/** Min-max normalize each retrieval arm across the candidate set. */
function normalizeArms(
  scores: Map<number, { vec: number; kw: number; sym: number }>
): void {
  for (const arm of ["vec", "kw", "sym"] as const) {
    let min = Infinity;
    let max = -Infinity;
    for (const s of scores.values()) {
      if (s[arm] < min) min = s[arm];
      if (s[arm] > max) max = s[arm];
    }
    if (max <= 0 || max === min) continue;
    for (const s of scores.values()) {
      if (s[arm] > 0) s[arm] = (s[arm] - min) / (max - min);
    }
  }
}

/** Lowercased content words for keyword/feature matching. */
function extractTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  return [...new Set(words.filter((w) => !STOPWORDS.has(w)))].slice(0, 6);
}

/** Identifier-looking tokens (camelCase, snake_case, PascalCase). */
function extractIdentifiers(query: string): string[] {
  const tokens = query.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [];
  const idents = tokens.filter(
    (t) => /[A-Z]/.test(t.slice(1)) || t.includes("_") || /^[a-z]+$/.test(t)
  );
  const filtered = idents.filter((t) => !STOPWORDS.has(t.toLowerCase()));
  // Prefer distinctly identifier-shaped tokens first.
  filtered.sort((a, b) => shapeScore(b) - shapeScore(a));
  return [...new Set(filtered)];
}

function shapeScore(token: string): number {
  if (/[a-z][A-Z]/.test(token)) return 3; // camelCase
  if (token.includes("_")) return 2;
  if (/^[A-Z]/.test(token)) return 1;
  return 0;
}

/** Minimal glob: ** spans directories, * stays in one segment. */
function globToRegex(glob: string): RegExp {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 3;
      } else {
        out += ".*";
        i += 2;
      }
    } else if (ch === "*") {
      out += "[^/]*";
      i += 1;
    } else if (ch === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`, "i");
}

function normalizeKind(kind: string): RetrievedChunk["kind"] {
  return kind === "code" ||
    kind === "doc" ||
    kind === "feature-summary" ||
    kind === "lesson" ||
    kind === "session-memory" ||
    kind === "global-session-memory"
    ? kind
    : "code";
}

function cosine(a: Float32Array, blob: Buffer): number {
  const b = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  let dot = 0;
  for (let i = 0; i < a.length && i < b.length; i++) dot += a[i]! * b[i]!;
  return dot;
}
