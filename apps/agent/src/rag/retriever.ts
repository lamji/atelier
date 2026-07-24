import type {
  Feature,
  GraphNode,
  RetrievalResult,
  RetrievedChunk,
} from "@atelier/protocol";
import type { Db } from "../storage/db.js";
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
}

/**
 * Hybrid retrieval: vector top-k over chunk embeddings + keyword scan +
 * symbol-name graph matches + fresh feature summaries, merged and ranked.
 * Degrades gracefully — with no embeddings it is keyword+graph only.
 */
export class Retriever {
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
    filters?: { pathGlob?: string; kinds?: string[] }
  ): Promise<RetrievalResult> {
    const arms: string[] = [];
    const scores = new Map<number, { vec: number; kw: number; sym: number }>();
    const bump = (id: number, arm: "vec" | "kw" | "sym", score: number) => {
      const entry = scores.get(id) ?? { vec: 0, kw: 0, sym: 0 };
      entry[arm] = Math.max(entry[arm], score);
      scores.set(id, entry);
    };

    // Arm 1: vector similarity.
    if (this.embedder.available && this.hasEmbeddings()) {
      const [qvec] = await this.embedder.embed([query]);
      if (qvec) {
        const hits = this.vectors.search(qvec, k * 3);
        if (hits.length > 0) {
          arms.push("vector");
          for (const hit of hits) bump(hit.chunkId, "vec", hit.score);
        }
      }
    }

    // Arm 2: keyword occurrence over chunk text.
    const terms = extractTerms(query);
    if (terms.length > 0) {
      const perTerm = this.db.prepare(
        "SELECT id FROM chunks WHERE lower(text) LIKE ? LIMIT 300"
      );
      const hitCounts = new Map<number, number>();
      for (const term of terms) {
        const rows = perTerm.all(`%${term}%`) as Array<{ id: number }>;
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

    // Merge, filter, rank.
    const combined = [...scores.entries()].map(([id, s]) => ({
      id,
      score: 0.55 * s.vec + 0.3 * s.kw + 0.15 * s.sym,
    }));
    combined.sort((a, b) => b.score - a.score);

    const chunks: RetrievedChunk[] = [];
    const pathRe = filters?.pathGlob ? globToRegex(filters.pathGlob) : null;
    // LEFT JOIN: lesson/feature chunks have no file (file_id NULL by
    // design, so re-indexing never wipes them); path falls back to kind.
    const loadChunk = this.db.prepare(
      "SELECT c.id, COALESCE(f.path, c.kind) AS path, c.kind, c.text, " +
        "c.start_row, c.end_row " +
        "FROM chunks c LEFT JOIN files f ON f.id = c.file_id WHERE c.id = ?"
    );
    const fileless = (kind: string) =>
      kind === "lesson" || kind === "feature-summary";
    const usedLessonChunks: number[] = [];
    for (const hit of combined) {
      if (chunks.length >= k) break;
      const row = loadChunk.get(hit.id) as ChunkRow | undefined;
      if (!row) continue;
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
      });
    }
    this.lessons.markUsed(usedLessonChunks);

    const strategy =
      arms.length > 0 ? `hybrid(${arms.join("+")})` : "empty(no-index)";
    return { strategy, chunks, graphNodes, features };
  }

  private hasEmbeddings(): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) n FROM chunk_embeddings")
      .get() as { n: number };
    return row.n > 0;
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
    const matched = rows.filter((f) => {
      const hay = `${f.name} ${f.summary}`.toLowerCase();
      return terms.some((t) => hay.includes(t));
    });
    return matched.slice(0, 5).map((f) => ({
      id: f.id,
      name: f.name,
      slug: f.slug,
      summary: f.summary,
      detailMd: f.detail_md ?? undefined,
      status: f.status as Feature["status"],
      updatedAt: f.updated_at,
      files: [],
    }));
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
    kind === "lesson"
    ? kind
    : "code";
}
