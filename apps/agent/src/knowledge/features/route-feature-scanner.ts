import { createHash } from "node:crypto";
import type { Db } from "../../storage/db.js";
import type { EventBus } from "../../events/event-bus.js";
import type { Embedder } from "../embeddings/embedder.js";
import type { VectorStore } from "../embeddings/vector-store.js";
import type { FileService } from "../../workspace/file-service.js";
import { discoverRoutes, type DiscoveredRoute } from "./route-scanner.js";

/** Stamps each route feature so a later scan knows it's already summarized. */
const MODEL_VERSION = "route-feature-v1";
/** Reachable files per route pulled into a feature (bounded). */
const MAX_REACHABLE = 14;
const MAX_ENTRY_CHARS = 6000;

interface FeatureDraft {
  name: string;
  summary: string;
  subFeatures: string[];
}

/**
 * Builds a route-anchored feature model: discovers every page route and
 * API endpoint, then describes each from its own code — no LLM. It reads
 * the import closure reachable from the route and derives the feature
 * statically: the route + entry component name it, the imported component
 * files and the JSX tags in the entry become its sub-features (a dashboard
 * that pulls in AnalyticsCard, DateRangeFilter, ExportButton yields exactly
 * those), and endpoints add flow signals (auth, validation, database) found
 * in the handler source.
 *
 * The result is stored as a feature keyed on the URL ("route:/dashboard")
 * and embedded, so "add another analytics card to the dashboard" retrieves
 * the dashboard feature — its summary AND its files — straight into context.
 */
export class RouteFeatureScanner {
  private running = false;

  constructor(
    private db: Db,
    private bus: EventBus,
    private files: FileService,
    private embedder: Embedder,
    private vectors: VectorStore
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** Discover routes; kick the background summarize pass. Returns count. */
  async start(): Promise<{ started: boolean; routes: number }> {
    if (this.running) return { started: false, routes: 0 };
    const sources = await this.sourceFiles();
    const routes = discoverRoutes(sources).slice(0, 300);
    if (routes.length === 0) return { started: true, routes: 0 };
    this.running = true;
    void this.run(routes).finally(() => {
      this.running = false;
    });
    return { started: true, routes: routes.length };
  }

  private async run(routes: DiscoveredRoute[]): Promise<void> {
    // Resume: routes already summarized (fresh) in a prior scan are skipped,
    // but counted as done — so restarting shows 64/300, not 0/300, and only
    // the remaining routes hit Haiku. Stale features (files changed) fall out
    // of "fresh" and get re-summarized.
    const pending = routes.filter((route) => !this.isSummarized(route));
    let done = routes.length - pending.length;
    this.emit("discover", done, routes.length);
    for (const route of pending) {
      try {
        await this.summarizeRoute(route);
      } catch {
        // one bad route never sinks the scan
      }
      done += 1;
      this.emit("summarize", done, routes.length, label(route));
    }
    this.emit("done", routes.length, routes.length);
  }

  /** True when this route already has a fresh feature from the current model. */
  private isSummarized(route: DiscoveredRoute): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM features WHERE slug = ? AND status = 'fresh' " +
          "AND model_version = ? LIMIT 1"
      )
      .get(routeSlug(route), MODEL_VERSION);
    return row !== undefined;
  }

  /** Reads a route's reachable code and stores its feature (no LLM). */
  private async summarizeRoute(route: DiscoveredRoute): Promise<void> {
    const entryFileId = await this.resolveEntryFile(route);
    if (entryFileId === null) return;
    const reachable = this.reachableFiles(entryFileId);
    const entryCode = await this.readEntry(route.file);
    const symbols = this.topSymbols(reachable.ids);

    const draft = describeRoute(route, entryCode, reachable.paths, symbols);
    this.persist(route, draft, reachable);
  }

  private persist(
    route: DiscoveredRoute,
    draft: FeatureDraft,
    reachable: { ids: number[]; paths: string[] }
  ): void {
    const slug = routeSlug(route);
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
        draft.name,
        slug,
        draft.summary,
        draft.subFeatures.length
          ? `Inside:\n${draft.subFeatures.map((s) => `- ${s}`).join("\n")}`
          : null,
        MODEL_VERSION,
        now
      );
    const featureId = (
      this.db.prepare("SELECT id FROM features WHERE slug = ?").get(slug) as {
        id: number;
      }
    ).id;

    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM feature_files WHERE feature_id = ?")
        .run(featureId);
      const ins = this.db.prepare(
        "INSERT OR IGNORE INTO feature_files(feature_id, file_id, weight) " +
          "VALUES (?, ?, ?)"
      );
      // Entry file weighted highest so it leads retrieval.
      reachable.ids.forEach((id, i) => ins.run(featureId, id, i === 0 ? 2 : 1));
    })();

    void this.embed(featureId, route, draft, reachable.paths);
    const feature = this.featureRow(featureId);
    if (feature) this.bus.publish("knowledge.feature.updated", { feature });
  }

  /** Feature summary embedded as a chunk so RAG retrieves it by intent. */
  private async embed(
    featureId: number,
    route: DiscoveredRoute,
    draft: FeatureDraft,
    paths: string[]
  ): Promise<void> {
    const old = this.db
      .prepare("SELECT chunk_id FROM features WHERE id = ?")
      .get(featureId) as { chunk_id: number | null } | undefined;
    if (old?.chunk_id) {
      this.db.prepare("DELETE FROM chunks WHERE id = ?").run(old.chunk_id);
      this.vectors.forget([old.chunk_id]);
    }
    // Route + sub-features go into the embedded text so "dashboard card"
    // and "/dashboard" both match strongly.
    const text =
      `FEATURE: ${draft.name}\nRoute: ${label(route)}\n${draft.summary}\n` +
      (draft.subFeatures.length
        ? `Inside: ${draft.subFeatures.join(", ")}\n`
        : "") +
      `Files: ${paths.slice(0, 12).join(", ")}`;
    const info = this.db
      .prepare(
        "INSERT INTO chunks(file_id, symbol_id, kind, content_hash, text, " +
          "token_count) VALUES (NULL, NULL, 'feature-summary', ?, ?, ?)"
      )
      .run(sha1(text), text, Math.ceil(text.length / 4));
    const chunkId = Number(info.lastInsertRowid);
    this.db
      .prepare("UPDATE features SET chunk_id = ? WHERE id = ?")
      .run(chunkId, featureId);
    if (this.embedder.available) {
      const [vec] = await this.embedder.embed([text]);
      if (vec) this.vectors.upsert(chunkId, vec);
    }
  }

  /** Forward import closure from the entry file (bounded). */
  private reachableFiles(entryFileId: number): {
    ids: number[];
    paths: string[];
  } {
    const ids: number[] = [entryFileId];
    const seen = new Set(ids);
    let frontier = [entryFileId];
    while (frontier.length > 0 && ids.length < MAX_REACHABLE) {
      const next: number[] = [];
      for (const id of frontier) {
        const rows = this.db
          .prepare(
            "SELECT DISTINCT resolved_file_id AS id FROM imports " +
              "WHERE file_id = ? AND resolved_file_id IS NOT NULL"
          )
          .all(id) as Array<{ id: number }>;
        for (const r of rows) {
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          ids.push(r.id);
          next.push(r.id);
          if (ids.length >= MAX_REACHABLE) break;
        }
      }
      frontier = next;
    }
    const paths = ids.map(
      (id) =>
        (this.db.prepare("SELECT path FROM files WHERE id = ?").get(id) as {
          path: string;
        }).path
    );
    return { ids, paths };
  }

  private topSymbols(fileIds: number[]): string[] {
    if (fileIds.length === 0) return [];
    const ph = fileIds.map(() => "?").join(",");
    return (
      this.db
        .prepare(
          `SELECT name FROM symbols WHERE file_id IN (${ph}) ` +
            "AND parent_symbol_id IS NULL LIMIT 40"
        )
        .all(...fileIds) as Array<{ name: string }>
    ).map((r) => r.name);
  }

  /** The file behind a route: the declaring file, or the entry component. */
  private async resolveEntryFile(route: DiscoveredRoute): Promise<number | null> {
    const declaring = this.db
      .prepare("SELECT id FROM files WHERE path = ? COLLATE NOCASE")
      .get(route.file) as { id: number } | undefined;
    if (route.entry) {
      const sym = this.db
        .prepare(
          "SELECT file_id FROM symbols WHERE name = ? AND parent_symbol_id " +
            "IS NULL ORDER BY id LIMIT 1"
        )
        .get(route.entry) as { file_id: number } | undefined;
      if (sym) return sym.file_id;
    }
    return declaring?.id ?? null;
  }

  private async readEntry(relPath: string): Promise<string> {
    try {
      const { content } = await this.files.readFile(relPath);
      return content.slice(0, MAX_ENTRY_CHARS);
    } catch {
      return "";
    }
  }

  private async sourceFiles(): Promise<Array<{ path: string; content: string }>> {
    const paths = await this.files.allFiles();
    const wanted = paths.filter((p) =>
      /\.(tsx?|jsx?|vue|svelte|go|py|rb)$/.test(p)
    );
    const out: Array<{ path: string; content: string }> = [];
    for (const path of wanted.slice(0, 4000)) {
      try {
        const { content } = await this.files.readFile(path);
        out.push({ path, content });
      } catch {
        // unreadable/binary — skip
      }
    }
    return out;
  }

  private featureRow(id: number): import("@atelier/protocol").Feature | null {
    const row = this.db
      .prepare(
        "SELECT id, name, slug, summary, detail_md, status, updated_at " +
          "FROM features WHERE id = ?"
      )
      .get(id) as
      | {
          id: number;
          name: string;
          slug: string;
          summary: string;
          detail_md: string | null;
          status: string;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    const files = (
      this.db
        .prepare(
          "SELECT f.path FROM feature_files ff JOIN files f ON f.id = ff.file_id " +
            "WHERE ff.feature_id = ? ORDER BY ff.weight DESC LIMIT 20"
        )
        .all(id) as Array<{ path: string }>
    ).map((r) => r.path);
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      summary: row.summary,
      detailMd: row.detail_md ?? undefined,
      status: row.status as "fresh" | "stale" | "building",
      updatedAt: row.updated_at,
      files,
    };
  }

  private emit(
    phase: "discover" | "summarize" | "done",
    done: number,
    total: number,
    current?: string
  ): void {
    this.bus.publish("knowledge.features.scan", { phase, done, total, current });
  }
}

function label(route: DiscoveredRoute): string {
  return `${route.method ? `${route.method} ` : ""}${route.path}`;
}

function routeSlug(route: DiscoveredRoute): string {
  const kind = route.kind === "page" ? "page" : "api";
  const method = route.method ? `${route.method.toLowerCase()}-` : "";
  const path = route.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  return `route:${kind}:${method}${path || "root"}`;
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/**
 * Derives a product-feature description from a route's reachable code — the
 * static replacement for the old per-route Haiku call. Sub-features come
 * from the imported component files and the JSX tags in the entry; endpoints
 * add flow signals detected in the handler source. Nothing hits an LLM.
 */
function describeRoute(
  route: DiscoveredRoute,
  entryCode: string,
  reachablePaths: string[],
  symbols: string[]
): FeatureDraft {
  const isPage = route.kind === "page";
  const pieces = subFeatureNames(route, entryCode, reachablePaths);
  const signals = isPage ? [] : endpointSignals(entryCode);
  const subFeatures = unique([...signals, ...pieces]).slice(0, 12);

  const summary = isPage
    ? pageSummary(route, reachablePaths, pieces, symbols)
    : endpointSummary(route, reachablePaths, signals, symbols);

  return {
    name: featureName(route).slice(0, 90),
    summary: summary.slice(0, 700),
    subFeatures,
  };
}

/** Framework wrappers that carry no product meaning as a sub-feature. */
const GENERIC_TAGS = new Set([
  "Fragment", "Suspense", "Provider", "Router", "Routes", "Route", "Link",
  "NavLink", "Outlet", "StrictMode", "Component", "Helmet", "ErrorBoundary",
  "Switch", "Redirect", "Head", "Script",
]);

/** Handler-source patterns → a named flow inside an endpoint. */
const ENDPOINT_SIGNALS: Array<[RegExp, string]> = [
  [/\b(auth|jwt|token|session|bearer|passport|bcrypt)\b|req\.user/i, "authentication"],
  [/\b(zod|joi|yup|validate|express-validator)\b|\.(safe)?parse\(/i, "input validation"],
  [/\b(prisma|knex|sequelize|mongoose|repository)\b|\b(select|insert|update|delete)\b|\.(query|find|findOne|create|save|update|delete|insert)\(/i, "database access"],
  [/\b(multer|multipart|upload)\b|create(Read|Write)Stream/i, "file handling"],
  [/\b(axios|node-fetch|got)\b|fetch\(|http\.request/i, "outbound request"],
];

/** UI/sub-flow names from imported component files + JSX tags in the entry. */
function subFeatureNames(
  route: DiscoveredRoute,
  entryCode: string,
  reachablePaths: string[]
): string[] {
  // slice(1): index 0 is the route's own file, not a sub-feature.
  const fromFiles = reachablePaths.slice(1).map(baseName).filter(isComponentName);
  const fromJsx = jsxTags(entryCode);
  const self = route.entry ?? "";
  const raw = unique([...fromJsx, ...fromFiles]).filter(
    (n) => n !== self && !GENERIC_TAGS.has(n)
  );
  return unique(raw.map(humanize));
}

function endpointSignals(code: string): string[] {
  return ENDPOINT_SIGNALS.filter(([re]) => re.test(code)).map(([, name]) => name);
}

function pageSummary(
  route: DiscoveredRoute,
  reachablePaths: string[],
  pieces: string[],
  symbols: string[]
): string {
  const parts = [
    `Page route "${route.path}"` +
      (route.entry ? `, rendered by ${route.entry}` : "") +
      ".",
    `Spans ${fileCount(reachablePaths.length)}` +
      (pieces.length ? `, composing ${pieces.slice(0, 6).join(", ")}` : "") +
      ".",
  ];
  if (symbols.length) parts.push(`Key symbols: ${symbols.slice(0, 8).join(", ")}.`);
  return parts.join(" ");
}

function endpointSummary(
  route: DiscoveredRoute,
  reachablePaths: string[],
  signals: string[],
  symbols: string[]
): string {
  const method = route.method ? `${route.method} ` : "";
  const parts = [
    `API endpoint ${method}"${route.path}" declared in ${route.file}.`,
    `Spans ${fileCount(reachablePaths.length)}` +
      (signals.length ? `; involves ${signals.join(", ")}` : "") +
      ".",
  ];
  if (symbols.length) parts.push(`Key symbols: ${symbols.slice(0, 8).join(", ")}.`);
  return parts.join(" ");
}

/** A route's feature name: entry component (or path) for pages, verb+path for APIs. */
function featureName(route: DiscoveredRoute): string {
  if (route.kind !== "page") {
    return `${route.method ? `${route.method} ` : ""}${route.path}`;
  }
  const base = route.entry ? humanize(route.entry) : titleFromPath(route.path);
  return /page$/i.test(base) ? base : `${base} page`;
}

function titleFromPath(path: string): string {
  const seg = path.split("/").filter(Boolean).pop() ?? "";
  const clean = seg.replace(/^[:*]/, "").replace(/[-_]+/g, " ").trim();
  if (!clean) return "Home";
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** Bare file name without directory or a source extension. */
function baseName(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return file.replace(/\.(tsx?|jsx?|vue|svelte|go|py|rb)$/, "");
}

/** PascalCase, and not an index/types/utils barrel — i.e. a component. */
function isComponentName(name: string): boolean {
  if (!/^[A-Z][A-Za-z0-9]+$/.test(name)) return false;
  return !/^(Index|Types|Constants|Utils|Helpers|Styles|App)$/.test(name);
}

/** PascalCase JSX opening tags used in the entry (the rendered children). */
function jsxTags(code: string): string[] {
  const re = /<([A-Z][A-Za-z0-9]*)[\s/>]/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) out.push(m[1]!);
  return out;
}

/** "AnalyticsCard" -> "Analytics card", "DateRangeFilter" -> "Date range filter". */
function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function fileCount(n: number): string {
  return `${n} file${n === 1 ? "" : "s"}`;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
