import crypto from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Feature } from "@atelier/protocol";
import type { Db } from "../../storage/db.js";
import type { EventBus } from "../../events/event-bus.js";
import type { Embedder } from "../embeddings/embedder.js";
import type { VectorStore } from "../embeddings/vector-store.js";

const SEED_DELAY_MS = 30_000; // let the index settle after startup
const REFRESH_INTERVAL_MS = 5 * 60_000; // debounce for stale features
const BETWEEN_CALLS_MS = 2_000; // throttle SDK usage
const MODEL = "claude-haiku-4-5";
const MODEL_VERSION = "feature-v1-haiku";
const MIN_CLUSTER_FILES = 2;
const MAX_CLUSTERS = 30;

interface Cluster {
  slug: string;
  files: Array<{ id: number; path: string }>;
}

/**
 * LLM-assisted feature models: product-level concepts mapped to the code
 * that implements them. Seeding clusters files by directory/import
 * locality and summarizes each cluster with one low-effort SDK call;
 * refresh re-summarizes only features the indexer marked stale. All
 * background work pauses while interactive tasks run, so it never
 * competes with the user's session.
 */
export class FeatureModelService {
  private embedder: Embedder | null = null;
  private vectors: VectorStore | null = null;
  private isBusy: () => boolean = () => false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private working = false;
  private stopped = false;

  constructor(
    private db: Db,
    private bus: EventBus
  ) {}

  attach(embedder: Embedder, vectors: VectorStore): void {
    this.embedder = embedder;
    this.vectors = vectors;
  }

  setBusyProbe(isBusy: () => boolean): void {
    this.isBusy = isBusy;
  }

  /** Kick background seeding (when empty) + the stale-refresh loop. */
  start(): void {
    setTimeout(() => {
      if (this.stopped) return;
      void this.runOnce();
    }, SEED_DELAY_MS);
    this.timer = setInterval(() => {
      void this.runOnce();
    }, REFRESH_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  list(): Feature[] {
    const rows = this.db
      .prepare(
        "SELECT id, name, slug, summary, detail_md, status, updated_at " +
          "FROM features ORDER BY name"
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
    const filesFor = this.db.prepare(
      "SELECT f.path FROM feature_files ff JOIN files f ON f.id = ff.file_id " +
        "WHERE ff.feature_id = ? ORDER BY ff.weight DESC LIMIT 20"
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      summary: row.summary,
      detailMd: row.detail_md ?? undefined,
      status: (row.status as Feature["status"]) ?? "building",
      updatedAt: row.updated_at,
      files: (filesFor.all(row.id) as Array<{ path: string }>).map(
        (f) => f.path
      ),
    }));
  }

  markStaleForFiles(paths: string[]): void {
    if (paths.length === 0) return;
    const placeholders = paths.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE features SET status='stale' WHERE status='fresh' AND id IN (
           SELECT ff.feature_id FROM feature_files ff
           JOIN files f ON f.id = ff.file_id
           WHERE f.path IN (${placeholders}) COLLATE NOCASE
         )`
      )
      .run(...paths);
  }

  /** One background round: seed when empty, else refresh stale. */
  private async runOnce(): Promise<void> {
    if (this.working || this.stopped || this.isBusy()) return;
    this.working = true;
    try {
      const count = (
        this.db.prepare("SELECT COUNT(*) n FROM features").get() as {
          n: number;
        }
      ).n;
      if (count === 0) await this.seedFeatures();
      else await this.refreshStale();
    } catch {
      // background job; next interval retries
    } finally {
      this.working = false;
    }
  }

  async seedFeatures(): Promise<void> {
    for (const cluster of this.clusters()) {
      if (this.stopped) return;
      await this.waitWhileBusy();
      await this.summarizeCluster(cluster, null);
      await sleep(BETWEEN_CALLS_MS);
    }
  }

  async refreshStale(): Promise<void> {
    const stale = this.db
      .prepare(
        "SELECT id, slug, summary FROM features WHERE status='stale' LIMIT 10"
      )
      .all() as Array<{ id: number; slug: string; summary: string }>;
    for (const feature of stale) {
      if (this.stopped) return;
      await this.waitWhileBusy();
      const files = this.db
        .prepare(
          "SELECT f.id, f.path FROM feature_files ff " +
            "JOIN files f ON f.id = ff.file_id WHERE ff.feature_id = ?"
        )
        .all(feature.id) as Array<{ id: number; path: string }>;
      if (files.length === 0) continue;
      await this.summarizeCluster(
        { slug: feature.slug, files },
        feature.summary
      );
      await sleep(BETWEEN_CALLS_MS);
    }
  }

  // ------------------------------------------------------------- internal

  /**
   * Directory + import-graph community clustering (label propagation).
   * Labels seed from each file's directory, then propagate along import
   * edges — so a cross-layer feature (LoginForm.tsx + useAuth.ts +
   * auth-service.ts) converges into ONE community even when its files
   * live in different folders, while unconnected files keep folder
   * cohesion. Deterministic: sorted iteration, lexicographic tie-breaks.
   */
  private clusters(): Cluster[] {
    const files = this.db
      .prepare("SELECT id, path FROM files WHERE parse_status='ok' ORDER BY path")
      .all() as Array<{ id: number; path: string }>;
    if (files.length === 0) return [];
    const byId = new Map(files.map((f) => [f.id, f]));

    // Undirected weighted adjacency from resolved imports.
    const edges = this.db
      .prepare(
        "SELECT file_id AS a, resolved_file_id AS b, COUNT(*) AS w " +
          "FROM imports WHERE resolved_file_id IS NOT NULL " +
          "GROUP BY file_id, resolved_file_id"
      )
      .all() as Array<{ a: number; b: number; w: number }>;
    const adj = new Map<number, Map<number, number>>();
    const bump = (x: number, y: number, w: number) => {
      if (!byId.has(x) || !byId.has(y)) return;
      const row = adj.get(x) ?? new Map<number, number>();
      row.set(y, (row.get(y) ?? 0) + w);
      adj.set(x, row);
    };
    for (const e of edges) {
      bump(e.a, e.b, e.w);
      bump(e.b, e.a, e.w);
    }

    // Seed labels from directories (folder cohesion as the prior).
    const dirOf = (path: string): string => {
      const segments = path.split("/");
      return segments.slice(0, Math.min(segments.length - 1, 4)).join("/") || "root";
    };
    const label = new Map<number, string>();
    for (const file of files) label.set(file.id, dirOf(file.path));

    // Label propagation: each file adopts its neighbors' dominant label.
    const SELF_WEIGHT = 1.5; // inertia keeps folders from dissolving
    for (let round = 0; round < 8; round++) {
      let changed = 0;
      for (const file of files) {
        const votes = new Map<string, number>();
        votes.set(label.get(file.id)!, SELF_WEIGHT);
        for (const [neighbor, weight] of adj.get(file.id) ?? []) {
          const l = label.get(neighbor);
          if (l) votes.set(l, (votes.get(l) ?? 0) + weight);
        }
        let best = label.get(file.id)!;
        let bestScore = -1;
        for (const [l, score] of [...votes.entries()].sort()) {
          if (score > bestScore) {
            best = l;
            bestScore = score;
          }
        }
        if (best !== label.get(file.id)) {
          label.set(file.id, best);
          changed += 1;
        }
      }
      if (changed === 0) break;
    }

    // Communities -> clusters; tiny ones fold into their parent directory.
    const communities = new Map<string, Array<{ id: number; path: string }>>();
    for (const file of files) {
      const l = label.get(file.id)!;
      const list = communities.get(l) ?? [];
      list.push(file);
      communities.set(l, list);
    }
    const folded = new Map<string, Array<{ id: number; path: string }>>();
    for (const [key, list] of communities) {
      const target =
        list.length >= MIN_CLUSTER_FILES
          ? key
          : key.split("/").slice(0, 2).join("/") || key;
      folded.set(target, [...(folded.get(target) ?? []), ...list]);
    }
    return [...folded.entries()]
      .filter(([, list]) => list.length >= MIN_CLUSTER_FILES)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, MAX_CLUSTERS)
      .map(([key, list]) => ({ slug: slugify(dominantDir(list, key)), files: list }));
  }

  private async summarizeCluster(
    cluster: Cluster,
    priorSummary: string | null
  ): Promise<void> {
    const fileIds = cluster.files.map((f) => f.id);
    const placeholders = fileIds.map(() => "?").join(",");
    const symbols = this.db
      .prepare(
        `SELECT s.id, s.name, s.kind FROM symbols s
         WHERE s.file_id IN (${placeholders}) AND s.parent_symbol_id IS NULL
         ORDER BY s.id LIMIT 40`
      )
      .all(...fileIds) as Array<{ id: number; name: string; kind: string }>;

    const prompt =
      `Summarize this code module as a product feature.\n` +
      `Files:\n${cluster.files.map((f) => `- ${f.path}`).join("\n")}\n` +
      `Key symbols: ${symbols.map((s) => `${s.name} (${s.kind})`).join(", ")}\n` +
      (priorSummary ? `Previous summary: ${priorSummary}\n` : "") +
      `\nReply with ONLY JSON: {"name":"Short feature name",` +
      `"summary":"2-3 sentences: what this feature does and how the parts ` +
      `fit together","detail":"optional markdown detail"}`;

    const raw = await this.shortSdkCall(prompt);
    const parsed = extractJson(raw) as {
      name?: string;
      summary?: string;
      detail?: string;
    } | null;
    if (!parsed?.name || !parsed.summary) return;

    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO features(name, slug, summary, detail_md, status, " +
          "model_version, updated_at) VALUES (?, ?, ?, ?, 'fresh', ?, ?) " +
          "ON CONFLICT(slug) DO UPDATE SET name=excluded.name, " +
          "summary=excluded.summary, detail_md=excluded.detail_md, " +
          "status='fresh', model_version=excluded.model_version, " +
          "updated_at=excluded.updated_at"
      )
      .run(
        parsed.name.slice(0, 80),
        cluster.slug,
        parsed.summary.slice(0, 600),
        parsed.detail?.slice(0, 2000) ?? null,
        MODEL_VERSION,
        now
      );
    const featureId = (
      this.db
        .prepare("SELECT id FROM features WHERE slug = ?")
        .get(cluster.slug) as { id: number }
    ).id;

    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM feature_files WHERE feature_id = ?")
        .run(featureId);
      const insertFile = this.db.prepare(
        "INSERT INTO feature_files(feature_id, file_id, weight) VALUES (?, ?, 1.0)"
      );
      for (const file of cluster.files) insertFile.run(featureId, file.id);
      this.db
        .prepare("DELETE FROM feature_symbols WHERE feature_id = ?")
        .run(featureId);
      const insertSym = this.db.prepare(
        "INSERT OR IGNORE INTO feature_symbols(feature_id, symbol_id) VALUES (?, ?)"
      );
      for (const sym of symbols.slice(0, 20)) insertSym.run(featureId, sym.id);
    })();

    await this.rewriteFeatureChunk(
      featureId,
      parsed.name,
      parsed.summary,
      cluster
    );

    const feature = this.list().find((f) => f.id === featureId);
    if (feature) {
      this.bus.publish("knowledge.feature.updated", { feature });
    }
  }

  /** Feature summaries live as embedded chunks so RAG can retrieve them. */
  private async rewriteFeatureChunk(
    featureId: number,
    name: string,
    summary: string,
    cluster: Cluster
  ): Promise<void> {
    const old = this.db
      .prepare("SELECT chunk_id FROM features WHERE id = ?")
      .get(featureId) as { chunk_id: number | null } | undefined;
    if (old?.chunk_id) {
      this.db.prepare("DELETE FROM chunks WHERE id = ?").run(old.chunk_id);
      this.vectors?.forget([old.chunk_id]);
    }
    const text =
      `FEATURE: ${name}\n${summary}\n` +
      `Files: ${cluster.files.slice(0, 12).map((f) => f.path).join(", ")}`;
    const info = this.db
      .prepare(
        "INSERT INTO chunks(file_id, symbol_id, kind, content_hash, text, token_count) " +
          "VALUES (NULL, NULL, 'feature-summary', ?, ?, ?)"
      )
      .run(sha1(text), text, Math.ceil(text.length / 4));
    const chunkId = Number(info.lastInsertRowid);
    this.db
      .prepare("UPDATE features SET chunk_id = ? WHERE id = ?")
      .run(chunkId, featureId);
    if (this.embedder?.available && this.vectors) {
      const [vec] = await this.embedder.embed([text]);
      if (vec) this.vectors.upsert(chunkId, vec);
    }
  }

  private async shortSdkCall(prompt: string): Promise<string> {
    const stream = query({
      prompt,
      options: {
        systemPrompt:
          "You summarize code modules as product features. Reply with " +
          "ONLY valid JSON, no prose.",
        model: MODEL,
        maxTurns: 1,
        disallowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
        strictMcpConfig: true,
        settingSources: [],
      },
    });
    let text = "";
    for await (const message of stream) {
      const m = message as Record<string, unknown>;
      if (m.type === "result" && typeof m.result === "string") text = m.result;
    }
    return text;
  }

  private async waitWhileBusy(): Promise<void> {
    while (this.isBusy() && !this.stopped) {
      await sleep(5_000);
    }
  }
}

/** A stable, human-ish slug seed: the most common directory in the group. */
function dominantDir(
  files: Array<{ path: string }>,
  fallback: string
): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    const segments = file.path.split("/");
    const dir = segments.slice(0, Math.min(segments.length - 1, 4)).join("/");
    if (dir) counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  let best = fallback;
  let bestCount = -1;
  for (const [dir, count] of [...counts.entries()].sort()) {
    if (count > bestCount) {
      best = dir;
      bestCount = count;
    }
  }
  return best;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function sha1(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
