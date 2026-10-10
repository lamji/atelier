import type { RetrievedChunk } from "@atelier/protocol";
import type { Db } from "../../storage/db.js";

export const FEATURE_CONTEXT_MODEL_VERSION =
    "session-context-tree-sitter-v1";

const MAX_SEED_SYMBOLS = 16;
const MAX_SEED_FILES = 16;
const MAX_SYMBOLS = 96;
const MAX_FILES = 40;
const CALL_DEPTH = 4;
const IMPORT_DEPTH = 2;
const MAX_RENDERED_CALLS = 48;
const MAX_RENDERED_IMPORTS = 32;
const MAX_RENDERED_FLOWS = 12;
const MAX_RENDERED_FLOW_DEPTH = CALL_DEPTH * 2 + 1;

/** Entry-point candidates offered for one screen. */
const MAX_ENTRY_POINTS = 8;
/** The radius walks further than /context: it is read once, not per turn. */
const RADIUS_CALL_DEPTH = 6;
const RADIUS_MAX_SYMBOLS = 400;

/** Files whose name says they render or route a screen. */
const ENTRY_FILE = /(^|\/)(pages?|views?|screens?|routes?|app|features?)(\/|$)/i;
/** Symbols whose name says the same. */
const ENTRY_SYMBOL = /(page|view|screen|route|router|layout|panel|dashboard)$/i;
/** Files that are never a screen's entry point, however well they match. */
const NOT_ENTRY = /(\.test\.|\.spec\.|__tests__|\.stories\.|\.d\.ts$)/i;

interface SymbolRow {
    id: number;
    fileId: number;
    path: string;
    name: string;
    kind: string;
    signature: string | null;
    startRow: number;
}

interface FileRow {
    id: number;
    path: string;
}

interface CallRow {
    callerId: number;
    calleeId: number | null;
    calleeName: string;
    siteRow: number;
}

interface ImportRow {
    fromId: number;
    toId: number;
}

/** A ranked candidate for the symbol that renders a marked screen. */
export interface EntryPointMatch extends SymbolRow {
    score: number;
}

/** Everything reachable from a screen's entry points, both directions. */
export interface ImpactRadius {
    symbols: SymbolRow[];
    files: FileRow[];
    calls: CallRow[];
    imports: ImportRow[];
    roles: Map<number, string>;
}

export interface SessionFeatureContext {
    featureId: number;
    name: string;
    slug: string;
    status: "fresh" | "stale" | "building";
    summary: string;
    detail: string;
    files: string[];
    symbols: Array<{
        id: number;
        name: string;
        kind: string;
        path: string;
        row: number;
        role: string;
    }>;
    queryHint: string;
    updatedAt: number;
}

export interface FeatureContextActivation {
    context: SessionFeatureContext;
    calls: number;
    imports: number;
}

/** An activation plus what /context_update actually changed about the map. */
export interface FeatureContextRefresh extends FeatureContextActivation {
    previous: SessionFeatureContext | null;
    addedFiles: string[];
    removedFiles: string[];
}

const DETAILED_REPORT_MARKERS = [
    "### Entrypoint paths",
    "### End-to-end flow graph",
    "### Indexed call edges",
    "### Import flow",
    "### Feature files",
] as const;

/**
 * Refuse to report a successful pin when the payload is only the legacy
 * summary. A stale or incomplete bundle must fail visibly instead of claiming
 * the conversation was equipped without showing the evidence graph.
 */
function requireDetailedReport(detail: string): string {
    const missing = DETAILED_REPORT_MARKERS.filter(
        (marker) => !detail.includes(marker)
    );
    if (missing.length > 0) {
        throw new Error(
            "Feature context was built without its detailed report (" +
                missing.join(", ") +
                "). Rebuild and restart the Atelier agent bundle."
        );
    }
    return detail;
}

/**
 * The direct /context reply. Detail leads deliberately: the process rail is
 * the user's report surface, so it must open on entrypoints and flow rather
 * than a generic "equipped" sentence.
 */
export function renderFeatureContextActivationReport(
    result: FeatureContextActivation
): string {
    return [
        requireDetailedReport(result.context.detail),
        "",
        "---",
        "",
        "**Context status:** Pinned \"" +
            result.context.name +
            "\" to this conversation from the current tree-sitter index (" +
            result.context.files.length +
            " files, " +
            result.context.symbols.length +
            " symbols, " +
            result.calls +
            " call edges, " +
            result.imports +
            " import edges).",
        "Claude and Codex receive this map on every later send. Run " +
            "/context_update after a large code change.",
    ].join("\n");
}

/** The report-first /context_update reply plus its concrete file delta. */
export function renderFeatureContextRefreshReport(
    result: FeatureContextRefresh
): string {
    const changes: string[] = [];
    if (result.addedFiles.length > 0) {
        changes.push("added " + featureFileList(result.addedFiles));
    }
    if (result.removedFiles.length > 0) {
        changes.push("dropped " + featureFileList(result.removedFiles));
    }
    return [
        requireDetailedReport(result.context.detail),
        "",
        "---",
        "",
        "**Context status:** Rebuilt \"" +
            result.context.name +
            "\" from the current tree-sitter index (" +
            result.context.files.length +
            " files, " +
            result.context.symbols.length +
            " symbols, " +
            result.calls +
            " call edges, " +
            result.imports +
            " import edges).",
        changes.length > 0
            ? "Files " + changes.join(" and ") + "."
            : "The same files are still in the flow.",
        "Claude and Codex receive the updated map on every later send.",
    ].join("\n");
}

function featureFileList(paths: string[], max = 6): string {
    const shown = paths.slice(0, max).join(", ");
    return paths.length > max
        ? shown + " and " + String(paths.length - max) + " more"
        : shown;
}

/**
 * Materializes one product feature from the tree-sitter knowledge index and
 * pins it to a conversation. The association is provider-neutral: Claude,
 * Codex, and local providers all receive the same compiled block.
 */
export class FeatureContextStore {
    /**
     * Entry points the last /entry_point pinned, per conversation.
     *
     * Deliberately in memory: it is a hand-off between two commands the
     * user runs back to back, not a fact about the workspace worth a
     * migration. /impact_radius re-derives from its own screenshot whenever
     * one rides along, so losing this on restart costs nothing but a
     * re-run of /entry_point.
     */
    private lastEntries = new Map<string, number[]>();

    constructor(private db: Db) { }

    rememberEntryPoints(conversationId: string, symbolIds: number[]): void {
        this.lastEntries.set(conversationId, symbolIds);
    }

    lastEntryPoints(conversationId: string): number[] {
        return this.lastEntries.get(conversationId) ?? [];
    }

    activate(
        conversationId: string,
        requestedName: string
    ): FeatureContextActivation {
        const name = cleanName(requestedName);
        if (!name) throw new Error("Usage: /context <feature>");
        if (!this.conversationExists(conversationId)) {
            throw new Error("Unknown conversation: " + conversationId);
        }

        const terms = featureTerms(name);
        if (terms.length === 0) {
            throw new Error("Feature name must contain letters or numbers.");
        }

        const symbolSeeds = this.symbolSeeds(name, terms);
        const fileWeights = this.fileSeeds(name, terms);
        this.addExistingFeatureSeeds(name, terms, fileWeights, symbolSeeds);

        if (symbolSeeds.size === 0 && fileWeights.size === 0) {
            // Nothing matched even ONE term now, so this is a real miss
            // rather than the old all-terms gate failing on a conjunction.
            // Name what the index does have nearby: "no match" with no
            // alternatives reads as "your feature does not exist", which is
            // what it wrongly said about a page the user was looking at.
            const near = this.nearestIndexed(terms);
            throw new Error(
                'Nothing in the tree-sitter index matched "' +
                name +
                '".' +
                (near.length > 0
                    ? " Closest indexed paths: " + near.join(", ") + "."
                    : "") +
                " Try a single distinctive word from the feature, or a file " +
                "name from it. If the workspace was just opened, indexing " +
                "may still be running."
            );
        }

        this.addEntrySymbols(fileWeights, symbolSeeds, terms);
        const expanded = this.expandCalls(symbolSeeds);
        const roles = expanded.roles;
        const calls = expanded.calls;
        const selectedSymbols = this.loadSymbols([...roles.keys()]);
        for (const symbol of selectedSymbols) {
            const weight = roles.get(symbol.id) === "seed" ? 4 : 2;
            fileWeights.set(
                symbol.fileId,
                Math.max(fileWeights.get(symbol.fileId) ?? 0, weight)
            );
        }

        const imports = this.expandImports(fileWeights);
        const files = this.loadFiles([...fileWeights.keys()]);
        const detail = renderDetail(
            name,
            files,
            selectedSymbols,
            roles,
            calls,
            imports
        );
        const slug = "context:" + slugify(name);
        const summary =
            "Tree-sitter session context for " +
            name +
            ": " +
            files.length +
            " files, " +
            selectedSymbols.length +
            " symbols, " +
            calls.length +
            " call edges, and " +
            imports.length +
            " import edges.";
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
            .run(name, slug, summary, detail, FEATURE_CONTEXT_MODEL_VERSION, now);

        const featureId = (
            this.db.prepare("SELECT id FROM features WHERE slug = ?").get(slug) as {
                id: number;
            }
        ).id;

        this.db.transaction(() => {
            this.db
                .prepare("DELETE FROM feature_files WHERE feature_id = ?")
                .run(featureId);
            this.db
                .prepare("DELETE FROM feature_symbols WHERE feature_id = ?")
                .run(featureId);

            const addFile = this.db.prepare(
                "INSERT INTO feature_files(feature_id, file_id, weight) VALUES (?, ?, ?)"
            );
            for (const file of files) {
                addFile.run(featureId, file.id, fileWeights.get(file.id) ?? 1);
            }

            const addSymbol = this.db.prepare(
                "INSERT INTO feature_symbols(feature_id, symbol_id, role) VALUES (?, ?, ?)"
            );
            for (const symbol of selectedSymbols) {
                addSymbol.run(featureId, symbol.id, roles.get(symbol.id) ?? "connected");
            }

            this.db
                .prepare(
                    "INSERT INTO conversation_feature_contexts(" +
                    "conversation_id, feature_id, requested_name, updated_at" +
                    ") VALUES (?, ?, ?, ?) " +
                    "ON CONFLICT(conversation_id) DO UPDATE SET " +
                    "feature_id=excluded.feature_id, " +
                    "requested_name=excluded.requested_name, " +
                    "updated_at=excluded.updated_at"
                )
                .run(conversationId, featureId, name, now);
        })();

        const context = this.get(conversationId);
        if (!context) {
            throw new Error("Feature context was created but could not be loaded.");
        }
        return { context, calls: calls.length, imports: imports.length };
    }

    /**
     * Rebuilds this conversation's pinned map from the tree-sitter rows as
     * they are now, without the user retyping the feature name. Refreshing
     * is not conditional on the stale flag: files added since the pin are
     * new callers, and nothing marks the old map stale for those.
     */
    refresh(
        conversationId: string,
        requestedName?: string
    ): FeatureContextRefresh {
        const previous = this.get(conversationId);
        const name = cleanName(requestedName ?? "") || this.pinnedName(conversationId);
        if (!name) {
            throw new Error(
                "This conversation is not pinned to a feature yet. " +
                "Run /context <feature> first — for example, /context login."
            );
        }
        const activation = this.activate(conversationId, name);
        return {
            ...activation,
            previous,
            addedFiles: added(previous?.files ?? [], activation.context.files),
            removedFiles: added(activation.context.files, previous?.files ?? []),
        };
    }

    /** The feature name the user typed when this conversation was pinned. */
    pinnedName(conversationId: string): string | null {
        const row = this.db
            .prepare(
                "SELECT requested_name FROM conversation_feature_contexts " +
                "WHERE conversation_id = ?"
            )
            .get(conversationId) as { requested_name: string } | undefined;
        return row?.requested_name ?? null;
    }

    get(conversationId: string): SessionFeatureContext | null {
        const row = this.db
            .prepare(
                "SELECT f.id, f.name, f.slug, f.status, f.summary, f.detail_md, " +
                "f.updated_at FROM conversation_feature_contexts cfc " +
                "JOIN features f ON f.id = cfc.feature_id " +
                "WHERE cfc.conversation_id = ?"
            )
            .get(conversationId) as
            | {
                id: number;
                name: string;
                slug: string;
                status: SessionFeatureContext["status"];
                summary: string;
                detail_md: string | null;
                updated_at: number;
            }
            | undefined;
        if (!row) return null;

        const files = (
            this.db
                .prepare(
                    "SELECT f.path FROM feature_files ff JOIN files f ON f.id = ff.file_id " +
                    "WHERE ff.feature_id = ? ORDER BY ff.weight DESC, f.path"
                )
                .all(row.id) as Array<{ path: string }>
        ).map((file) => file.path);
        const symbols = this.db
            .prepare(
                "SELECT s.id, s.name, s.kind, f.path, s.start_row, fs.role " +
                "FROM feature_symbols fs JOIN symbols s ON s.id = fs.symbol_id " +
                "JOIN files f ON f.id = s.file_id WHERE fs.feature_id = ? " +
                "ORDER BY CASE fs.role WHEN 'seed' THEN 0 WHEN 'entry' THEN 1 ELSE 2 END, " +
                "f.path, s.start_row LIMIT ?"
            )
            .all(row.id, MAX_SYMBOLS) as Array<{
                id: number;
                name: string;
                kind: string;
                path: string;
                start_row: number;
                role: string | null;
            }>;

        const hintSymbols = symbols
            .slice(0, 12)
            .map((symbol) => symbol.name)
            .join(" ");
        const hintFiles = files
            .slice(0, 8)
            .map((file) => file.split("/").pop() ?? file)
            .join(" ");
        return {
            featureId: row.id,
            name: row.name,
            slug: row.slug,
            status: row.status,
            summary: row.summary,
            detail: row.detail_md ?? "",
            files,
            symbols: symbols.map((symbol) => ({
                id: symbol.id,
                name: symbol.name,
                kind: symbol.kind,
                path: symbol.path,
                row: symbol.start_row + 1,
                role: symbol.role ?? "connected",
            })),
            queryHint: [row.name, hintSymbols, hintFiles].filter(Boolean).join(" "),
            updatedAt: row.updated_at,
        };
    }

    /**
     * Code chunks already associated with the pinned feature. These are
     * prepended to ordinary retrieval so a follow-up can start debugging
     * without spending tool calls rediscovering the login files.
     */
    retrievalChunks(featureId: number, limit = 6): RetrievedChunk[] {
        const rows = this.db
            .prepare(
                "SELECT c.id, f.path, c.kind, c.text, c.start_row, c.end_row, " +
                "c.symbol_id, c.token_count, c.content_hash, " +
                "CASE WHEN fs.feature_id IS NOT NULL THEN 3 ELSE ff.weight END priority " +
                "FROM chunks c JOIN files f ON f.id = c.file_id " +
                "LEFT JOIN feature_symbols fs ON fs.symbol_id = c.symbol_id " +
                "AND fs.feature_id = ? " +
                "LEFT JOIN feature_files ff ON ff.file_id = c.file_id " +
                "AND ff.feature_id = ? " +
                "WHERE (fs.feature_id IS NOT NULL OR ff.feature_id IS NOT NULL) " +
                "AND c.kind IN ('code', 'doc') " +
                "ORDER BY priority DESC, c.id LIMIT ?"
            )
            .all(featureId, featureId, limit) as Array<{
                id: number;
                path: string;
                kind: string;
                text: string;
                start_row: number | null;
                end_row: number | null;
                symbol_id: number | null;
                token_count: number;
                content_hash: string;
            }>;
        return rows.map((row, index) => ({
            id: row.id,
            path: row.path,
            kind: row.kind === "doc" ? "doc" : "code",
            score: Number((1 - index * 0.01).toFixed(4)),
            preview:
                row.text.length > 1600 ? row.text.slice(0, 1600) + "…" : row.text,
            startRow: row.start_row ?? undefined,
            endRow: row.end_row ?? undefined,
            symbolId: row.symbol_id ?? undefined,
            tokenCount: row.token_count,
            contentHash: row.content_hash,
            arms: { vec: 0, kw: 0, sym: 1 },
        }));
    }

    /**
     * Compact provider-facing form of a pinned feature. The detailed report
     * remains the user-facing /context result and stays in the knowledge
     * store; sending that entire graph on every follow-up duplicated retrieval
     * and could consume thousands of tokens.
     */
    render(context: SessionFeatureContext, relevantPaths: string[] = []): string {
        const relevant = new Set(relevantPaths);
        const matched = context.files.filter((file) => relevant.has(file));
        const files = (matched.length > 0 ? matched : context.files).slice(0, 12);
        const selected = new Set(files);
        const symbols = context.symbols
            .filter((symbol) => selected.has(symbol.path))
            .slice(0, 12);

        const parts = [
            "SESSION FEATURE CONTEXT — " + context.name,
            context.summary,
            "Use this compact index as a lead. The full compiled flow remains " +
                "available through retrieve_knowledge or query_knowledge_graph; " +
                "do not text-search merely to rediscover it.",
        ];
        if (files.length > 0) {
            parts.push(
                "Relevant feature files for this turn:",
                ...files.map((file) => "- " + file)
            );
        }
        if (symbols.length > 0) {
            parts.push(
                "Relevant symbols:",
                ...symbols.map(
                    (symbol) =>
                        "- " +
                        symbol.name +
                        " (" +
                        symbol.kind +
                        ", " +
                        symbol.role +
                        ") [" +
                        symbol.path +
                        ":" +
                        symbol.row +
                        "]"
                )
            );
        }
        if (context.files.length > files.length) {
            parts.push(
                String(context.files.length - files.length) +
                    " additional feature files omitted; retrieve them on demand."
            );
        }
        parts.push(
            "Run /context_update after a large code change if this pinned map is stale."
        );
        return parts.join("\n");
    }

    private conversationExists(conversationId: string): boolean {
        return (
            this.db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(conversationId) !==
            undefined
        );
    }

    /**
     * The symbols that RENDER a screen, ranked.
     *
     * A screenshot's strongest identifier is the route it was taken on, so
     * a path segment counts for more than a word read off the page, and a
     * symbol living in a router/page/view file counts for more than one of
     * the same name buried in a util. Nothing here reads the image: the
     * route and the labels come from the preview block the composer already
     * attaches, which is why this behaves identically on Codex and Claude.
     */
    entryPoints(terms: string[], routeTerms: string[]): EntryPointMatch[] {
        if (terms.length === 0) return [];
        const where = terms
            .map(() => "(lower(s.name) LIKE ? OR lower(f.path) LIKE ?)")
            .join(" OR ");
        const args = terms
            .slice(0, 8)
            .flatMap((term) => ["%" + term + "%", "%" + term + "%"]);
        const rows = this.db
            .prepare(
                "SELECT s.id, s.file_id AS fileId, f.path, s.name, s.kind, " +
                "s.signature, s.start_row AS startRow FROM symbols s " +
                "JOIN files f ON f.id = s.file_id WHERE " +
                terms.slice(0, 8).map(() => "(lower(s.name) LIKE ? OR lower(f.path) LIKE ?)").join(" OR ") +
                " LIMIT 900"
            )
            .all(...args) as SymbolRow[];
        const scored = rows
            .map((row) => ({ row, score: entryScore(row, terms, routeTerms) }))
            .filter((entry) => entry.score > 0)
            .sort(
                (a, b) =>
                    b.score - a.score ||
                    a.row.path.localeCompare(b.row.path) ||
                    a.row.startRow - b.row.startRow
            );
        return scored
            .slice(0, MAX_ENTRY_POINTS)
            .map((entry) => ({ ...entry.row, score: entry.score }));
    }

    /** Re-loads remembered entry points, so a second command can walk them. */
    entryPointsByIds(symbolIds: number[]): EntryPointMatch[] {
        return this.loadSymbols(symbolIds).map((row) => ({ ...row, score: 0 }));
    }

    /**
     * Everything reachable from a set of entry symbols, both directions.
     *
     * /context answers "what is this feature?" and is deliberately bounded
     * so it can ride in every prompt. This answers a different question —
     * "if I change this screen, what else is involved?" — so it walks
     * deeper and reports the whole reachable set rather than a compact
     * index. Callers are included as well as callees: a function this
     * screen depends on matters, and so does one that depends on it.
     */
    impactRadius(entryIds: number[]): ImpactRadius {
        const seeds = new Map<number, SymbolRow>(
            this.loadSymbols(entryIds).map((row) => [row.id, row])
        );
        if (seeds.size === 0) {
            return { symbols: [], files: [], calls: [], imports: [], roles: new Map() };
        }
        const expanded = this.expandCalls(seeds, RADIUS_CALL_DEPTH, RADIUS_MAX_SYMBOLS);
        const symbols = this.loadSymbols([...expanded.roles.keys()]);
        const fileWeights = new Map<number, number>();
        for (const symbol of symbols) {
            const weight = expanded.roles.get(symbol.id) === "seed" ? 4 : 2;
            fileWeights.set(
                symbol.fileId,
                Math.max(fileWeights.get(symbol.fileId) ?? 0, weight)
            );
        }
        const imports = this.expandImports(fileWeights);
        for (const edge of imports) {
            if (!fileWeights.has(edge.toId)) fileWeights.set(edge.toId, 1);
            if (!fileWeights.has(edge.fromId)) fileWeights.set(edge.fromId, 1);
        }
        return {
            symbols,
            files: this.loadFiles([...fileWeights.keys()]),
            calls: expanded.calls,
            imports,
            roles: expanded.roles,
        };
    }

    /**
     * Indexed paths that share a PREFIX of one of the terms, for the
     * not-found message. Deliberately looser than the seed match — its job
     * is to tell the user what vocabulary the index actually has, so a
     * failed /context ends in a next thing to try rather than a dead end.
     */
    private nearestIndexed(terms: string[]): string[] {
        const stems = terms
            .map((term) => term.slice(0, Math.max(4, term.length - 2)))
            .filter((stem) => stem.length >= 3);
        if (stems.length === 0) return [];
        const where = stems.map(() => "lower(path) LIKE ?").join(" OR ");
        const rows = this.db
            .prepare(
                "SELECT path FROM files WHERE parse_status = 'ok' AND (" +
                where +
                ") LIMIT 5"
            )
            .all(...stems.map((stem) => "%" + stem + "%")) as FileRow[];
        return rows.map((row) => row.path);
    }

    private symbolSeeds(name: string, terms: string[]): Map<number, SymbolRow> {
        const where = terms
            .map(() => "(lower(s.name) LIKE ? OR lower(f.path) LIKE ?)")
            .join(" OR ");
        const args = terms.flatMap((term) => ["%" + term + "%", "%" + term + "%"]);
        const rows = this.db
            .prepare(
                "SELECT s.id, s.file_id AS fileId, f.path, s.name, s.kind, " +
                "s.signature, s.start_row AS startRow FROM symbols s " +
                "JOIN files f ON f.id = s.file_id WHERE " +
                where +
                " LIMIT 800"
            )
            .all(...args) as SymbolRow[];
        const coherent = rankCandidates(
            rows,
            (row) => row.name + " " + row.path,
            name,
            terms,
            (a, b) => a.path.localeCompare(b.path) || a.startRow - b.startRow
        );
        return new Map(
            coherent.slice(0, MAX_SEED_SYMBOLS).map((row) => [row.id, row])
        );
    }

    private fileSeeds(name: string, terms: string[]): Map<number, number> {
        const where = terms.map(() => "lower(path) LIKE ?").join(" OR ");
        const rows = this.db
            .prepare(
                "SELECT id, path FROM files WHERE parse_status = 'ok' AND (" +
                where +
                ") LIMIT 600"
            )
            .all(...terms.map((term) => "%" + term + "%")) as FileRow[];
        const coherent = rankCandidates(
            rows,
            (row) => row.path,
            name,
            terms,
            (a, b) => a.path.localeCompare(b.path)
        );
        return new Map(
            coherent.slice(0, MAX_SEED_FILES).map((row) => [row.id, 4])
        );
    }

    private addExistingFeatureSeeds(
        name: string,
        terms: string[],
        fileWeights: Map<number, number>,
        symbolSeeds: Map<number, SymbolRow>
    ): void {
        const where = terms
            .map(() => "(lower(name) LIKE ? OR lower(slug) LIKE ?)")
            .join(" OR ");
        const args = terms.flatMap((term) => ["%" + term + "%", "%" + term + "%"]);
        const features = this.db
            .prepare(
                "SELECT id, name, slug FROM features WHERE (" +
                where +
                ") AND COALESCE(model_version, '') NOT LIKE 'session-context-%' LIMIT 20"
            )
            .all(...args) as Array<{ id: number; name: string; slug: string }>;
        const coherent = rankCandidates(
            features,
            (feature) => feature.name + " " + feature.slug,
            name,
            terms
        );
        for (const feature of coherent.slice(0, 3)) {
            const files = this.db
                .prepare(
                    "SELECT file_id FROM feature_files WHERE feature_id = ? " +
                    "ORDER BY weight DESC LIMIT 20"
                )
                .all(feature.id) as Array<{ file_id: number }>;
            for (const file of files) {
                fileWeights.set(
                    file.file_id,
                    Math.max(fileWeights.get(file.file_id) ?? 0, 3)
                );
            }
            const symbols = this.db
                .prepare(
                    "SELECT s.id, s.file_id AS fileId, f.path, s.name, s.kind, " +
                    "s.signature, s.start_row AS startRow FROM feature_symbols fs " +
                    "JOIN symbols s ON s.id = fs.symbol_id JOIN files f ON f.id = s.file_id " +
                    "WHERE fs.feature_id = ? LIMIT 30"
                )
                .all(feature.id) as SymbolRow[];
            for (const symbol of symbols) symbolSeeds.set(symbol.id, symbol);
        }
    }

    private addEntrySymbols(
        fileWeights: Map<number, number>,
        symbolSeeds: Map<number, SymbolRow>,
        terms: string[]
    ): void {
        const top = this.db.prepare(
            "SELECT s.id, s.file_id AS fileId, f.path, s.name, s.kind, " +
            "s.signature, s.start_row AS startRow FROM symbols s " +
            "JOIN files f ON f.id = s.file_id WHERE s.file_id = ? " +
            "AND s.parent_symbol_id IS NULL ORDER BY s.start_row LIMIT 8"
        );
        for (const fileId of [...fileWeights.keys()].slice(0, MAX_SEED_FILES)) {
            const rows = top.all(fileId) as SymbolRow[];
            const matched = rows.filter((row) =>
                terms.some((term) => row.name.toLowerCase().includes(term))
            );
            for (const row of (matched.length > 0 ? matched : rows.slice(0, 3))) {
                if (symbolSeeds.size >= MAX_SEED_SYMBOLS) break;
                symbolSeeds.set(row.id, row);
            }
        }
    }

    private expandCalls(
        seeds: Map<number, SymbolRow>,
        depthLimit = CALL_DEPTH,
        symbolLimit = MAX_SYMBOLS
    ): { roles: Map<number, string>; calls: CallRow[] } {
        const roles = new Map<number, string>(
            [...seeds.keys()].map((id) => [id, "seed"])
        );
        const calls = new Map<string, CallRow>();
        let frontier = [...seeds.keys()];

        for (let depth = 0; depth < depthLimit && frontier.length > 0; depth += 1) {
            const placeholders = frontier.map(() => "?").join(",");
            const rows = this.db
                .prepare(
                    "SELECT caller_symbol_id AS callerId, callee_symbol_id AS calleeId, " +
                    "callee_name AS calleeName, site_row AS siteRow FROM call_edges " +
                    "WHERE caller_symbol_id IN (" +
                    placeholders +
                    ") OR callee_symbol_id IN (" +
                    placeholders +
                    ") ORDER BY id LIMIT 600"
                )
                .all(...frontier, ...frontier) as CallRow[];
            const frontierSet = new Set(frontier);
            const next: number[] = [];
            for (const row of rows) {
                const key =
                    String(row.callerId) +
                    ">" +
                    String(row.calleeId ?? row.calleeName) +
                    ":" +
                    String(row.siteRow);
                calls.set(key, row);
                if (
                    frontierSet.has(row.callerId) &&
                    row.calleeId !== null &&
                    !roles.has(row.calleeId) &&
                    roles.size < symbolLimit
                ) {
                    roles.set(row.calleeId, "callee");
                    next.push(row.calleeId);
                }
                if (
                    row.calleeId !== null &&
                    frontierSet.has(row.calleeId) &&
                    !roles.has(row.callerId) &&
                    roles.size < symbolLimit
                ) {
                    roles.set(row.callerId, "caller");
                    next.push(row.callerId);
                }
            }
            frontier = [...new Set(next)];
        }
        return { roles, calls: [...calls.values()] };
    }

    private expandImports(fileWeights: Map<number, number>): ImportRow[] {
        const imports = new Map<string, ImportRow>();
        let frontier = [...fileWeights.keys()];

        for (let depth = 0; depth < IMPORT_DEPTH && frontier.length > 0; depth += 1) {
            const placeholders = frontier.map(() => "?").join(",");
            const rows = this.db
                .prepare(
                    "SELECT file_id AS fromId, resolved_file_id AS toId FROM imports " +
                    "WHERE resolved_file_id IS NOT NULL AND (file_id IN (" +
                    placeholders +
                    ") OR resolved_file_id IN (" +
                    placeholders +
                    ")) ORDER BY id LIMIT 600"
                )
                .all(...frontier, ...frontier) as ImportRow[];
            const frontierSet = new Set(frontier);
            const next: number[] = [];
            for (const row of rows) {
                imports.set(String(row.fromId) + ">" + String(row.toId), row);
                for (const id of [row.fromId, row.toId]) {
                    if (
                        frontierSet.has(id) ||
                        fileWeights.has(id) ||
                        fileWeights.size >= MAX_FILES
                    ) {
                        continue;
                    }
                    fileWeights.set(id, Math.max(1, IMPORT_DEPTH - depth));
                    next.push(id);
                }
            }
            frontier = [...new Set(next)];
        }
        return [...imports.values()];
    }

    private loadSymbols(ids: number[]): SymbolRow[] {
        if (ids.length === 0) return [];
        const placeholders = ids.map(() => "?").join(",");
        return this.db
            .prepare(
                "SELECT s.id, s.file_id AS fileId, f.path, s.name, s.kind, " +
                "s.signature, s.start_row AS startRow FROM symbols s " +
                "JOIN files f ON f.id = s.file_id WHERE s.id IN (" +
                placeholders +
                ") ORDER BY f.path, s.start_row"
            )
            .all(...ids) as SymbolRow[];
    }

    private loadFiles(ids: number[]): FileRow[] {
        if (ids.length === 0) return [];
        const placeholders = ids.map(() => "?").join(",");
        return this.db
            .prepare(
                "SELECT id, path FROM files WHERE id IN (" +
                placeholders +
                ") ORDER BY path"
            )
            .all(...ids) as FileRow[];
    }
}

function cleanName(value: string): string {
    return value.trim().replace(/\s+/g, " ").slice(0, 80);
}

/** Members of `next` that `before` did not have, in `next` order. */
function added(before: string[], next: string[]): string[] {
    const known = new Set(before);
    return next.filter((value) => !known.has(value));
}

/**
 * Words that join a product feature's name without naming anything in it.
 *
 * "Budgets and Alerts" is how the page is labelled in the UI, and it used
 * to fail: every term had to appear, "and" was a term, and no symbol is
 * called anything-and-anything. The conjunction has to go before the terms
 * are used for matching.
 */
const NAME_STOPWORDS = new Set([
    "and", "or", "the", "a", "an", "of", "for", "in", "on", "to", "with",
    "by", "at", "from", "into", "page", "screen", "view", "feature",
]);

export function featureTerms(value: string): string[] {
    const words = [
        ...new Set(value.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []),
    ];
    const meaningful = words.filter((word) => !NAME_STOPWORDS.has(word));
    // "The View" is a poor feature name but it is the one the user typed;
    // stripping it to nothing would be worse than matching it literally.
    return (meaningful.length > 0 ? meaningful : words).slice(0, 6);
}

/** How many of the search terms appear in this candidate. */
function termHits(haystack: string, terms: string[]): number {
    const hay = haystack.toLowerCase();
    return terms.filter((term) => hay.includes(term)).length;
}

/**
 * Candidates worth seeding a feature from, best first.
 *
 * This replaces an all-terms filter that could not express what a PRODUCT
 * feature is. "Budgets and Alerts" spans `BudgetsPage.tsx` and
 * `AlertsList.tsx`, and no single symbol or path contains both words — so
 * requiring every term in one haystack rejected the entire feature and
 * reported it as not existing, on a workspace where the user was looking
 * straight at it.
 *
 * So a candidate qualifies on ONE term and is then ranked: whole-phrase
 * matches first, then by how many terms it carries (see relevance), then
 * by path. Precision comes from the ranking and the cap the caller
 * applies, which is how the rest of Atelier's retrieval works — not from
 * an all-or-nothing gate that fails closed on the app's own vocabulary.
 */
export function rankCandidates<T>(
    rows: T[],
    haystackOf: (row: T) => string,
    name: string,
    terms: string[],
    tieBreak: (a: T, b: T) => number = () => 0
): T[] {
    return rows
        .filter((row) => termHits(haystackOf(row), terms) > 0)
        .sort(
            (a, b) =>
                relevance(haystackOf(b), name, terms) -
                relevance(haystackOf(a), name, terms) || tieBreak(a, b)
        );
}

function relevance(haystack: string, name: string, terms: string[]): number {
    const hay = haystack.toLowerCase();
    const phrase = name.toLowerCase();
    let score = hay === phrase ? 20 : hay.includes(phrase) ? 8 : 0;
    for (const term of terms) {
        if (hay.includes(term)) score += 3;
    }
    return score;
}

/**
 * How strongly one symbol looks like the thing that renders a given screen.
 *
 * Route segments outrank page text because a URL is chosen by the code and
 * a label is chosen by a designer; `/budgets-and-alerts` is far more likely
 * to appear in the router than the words on the heading are. File shape
 * then breaks ties: a match inside `src/pages/` is an entry point, the same
 * match inside `src/lib/format.ts` is a coincidence.
 */
export function entryScore(
    row: { name: string; path: string; kind: string },
    terms: string[],
    routeTerms: string[]
): number {
    if (NOT_ENTRY.test(row.path)) return 0;
    const name = row.name.toLowerCase();
    const path = row.path.toLowerCase();
    let score = 0;
    for (const term of routeTerms) {
        if (path.includes(term)) score += 6;
        if (name.includes(term)) score += 5;
    }
    for (const term of terms) {
        if (routeTerms.includes(term)) continue;
        if (path.includes(term)) score += 2;
        if (name.includes(term)) score += 2;
    }
    if (score === 0) return 0;
    if (ENTRY_FILE.test(row.path)) score += 4;
    if (ENTRY_SYMBOL.test(row.name)) score += 3;
    if (row.kind === "component" || row.kind === "function") score += 1;
    return score;
}

function slugify(value: string): string {
    return (
        value
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 64) || "feature"
    );
}

function renderDetail(
    name: string,
    files: FileRow[],
    symbols: SymbolRow[],
    roles: Map<number, string>,
    calls: CallRow[],
    imports: ImportRow[]
): string {
    const symbolById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
    const fileById = new Map(files.map((file) => [file.id, file]));
    const code = (value: string): string =>
        "`" + value.replace(/`/g, "'").replace(/\|/g, "\\|") + "`";
    const resolvedCalls = calls.filter(
        (call): call is CallRow & { calleeId: number } =>
            call.calleeId !== null &&
            symbolById.has(call.callerId) &&
            symbolById.has(call.calleeId)
    );
    const outgoing = new Map<number, number[]>();
    const incoming = new Set<number>();
    for (const call of resolvedCalls) {
        const targets = outgoing.get(call.callerId) ?? [];
        if (!targets.includes(call.calleeId)) targets.push(call.calleeId);
        outgoing.set(call.callerId, targets);
        incoming.add(call.calleeId);
    }

    // A matched symbol may sit in the middle of a flow. Prefer graph roots as
    // the report's entrypoints, then fall back to matched seeds when the
    // indexed calls form a cycle or contain no resolved edge.
    const roots = symbols.filter(
        (symbol) => outgoing.has(symbol.id) && !incoming.has(symbol.id)
    );
    const seeds = symbols.filter((symbol) => roles.get(symbol.id) === "seed");
    const entrySymbols = (roots.length > 0 ? roots : seeds).slice(0, 24);
    const entryLines = entrySymbols.map(
        (symbol) =>
            "| " +
            code(symbol.path + ":" + String(symbol.startRow + 1)) +
            " | " +
            code(symbol.name) +
            " | " +
            code(symbol.kind) +
            " |"
    );

    const flows: SymbolRow[][] = [];
    const flowKeys = new Set<string>();
    const visit = (
        symbol: SymbolRow,
        path: SymbolRow[],
        visited: Set<number>
    ): void => {
        if (flows.length >= MAX_RENDERED_FLOWS) return;
        const nextPath = [...path, symbol];
        const nextVisited = new Set(visited).add(symbol.id);
        const targets = (outgoing.get(symbol.id) ?? []).filter(
            (id) => !nextVisited.has(id)
        );
        if (
            nextPath.length >= MAX_RENDERED_FLOW_DEPTH ||
            targets.length === 0
        ) {
            if (nextPath.length > 1) {
                const key = nextPath.map((item) => item.id).join(">");
                if (!flowKeys.has(key)) {
                    flowKeys.add(key);
                    flows.push(nextPath);
                }
            }
            return;
        }
        for (const targetId of targets) {
            const target = symbolById.get(targetId);
            if (target) visit(target, nextPath, nextVisited);
        }
    };
    for (const entry of entrySymbols) {
        visit(entry, [], new Set<number>());
        if (flows.length >= MAX_RENDERED_FLOWS) break;
    }
    const flowLines = flows.map(
        (flow, index) =>
            String(index + 1) +
            ". **Functions:** " +
            flow.map((symbol) => code(symbol.name)).join(" -> ") +
            "\n   **Paths:** " +
            flow
                .map((symbol) =>
                    code(symbol.path + ":" + String(symbol.startRow + 1))
                )
                .join(" -> ")
    );
    // Fenced text becomes a reliable <pre> flowchart in the HTML report.
    // Unlike Mermaid it needs no optional client renderer, and every node
    // carries both the symbol and its concrete path:line.
    const flowGraphLines = flows.flatMap((flow, flowIndex) => {
        const nodes = flow.flatMap((symbol, nodeIndex) => {
            const label =
                nodeIndex === 0
                    ? "ENTRYPOINT"
                    : nodeIndex === flow.length - 1
                      ? "TERMINAL  "
                      : "CALL      ";
            const node = [
                label +
                    "  " +
                    symbol.name +
                    "  [" +
                    symbol.path +
                    ":" +
                    String(symbol.startRow + 1) +
                    "]",
            ];
            if (nodeIndex < flow.length - 1) {
                node.push("            |", "            v");
            }
            return node;
        });
        return [
            "#### Flow " + String(flowIndex + 1),
            "",
            "```text",
            ...nodes,
            "```",
            "",
        ];
    });
    const callLines = calls
        .filter(
            (call) =>
                symbolById.has(call.callerId) &&
                (call.calleeId === null || symbolById.has(call.calleeId))
        )
        .slice(0, MAX_RENDERED_CALLS)
        .map((call) => {
            const caller = symbolById.get(call.callerId)!;
            const callee =
                call.calleeId === null ? undefined : symbolById.get(call.calleeId);
            const target = callee
                ? callee.path +
                ":" +
                String(callee.startRow + 1) +
                " — " +
                callee.name
                : "unresolved — " + call.calleeName;
            return (
                "- " +
                caller.path +
                ":" +
                String(call.siteRow + 1) +
                " — " +
                caller.name +
                " -> " +
                target
            );
        });
    const importLines = imports
        .filter((edge) => fileById.has(edge.fromId) && fileById.has(edge.toId))
        .slice(0, MAX_RENDERED_IMPORTS)
        .map(
            (edge) =>
                "- " +
                fileById.get(edge.fromId)!.path +
                " -> " +
                fileById.get(edge.toId)!.path
        );

    return [
        "## " + name + " context report",
        "",
        "**Snapshot:** " +
            files.length +
            " files, " +
            symbols.length +
            " symbols, " +
            calls.length +
            " call edges, and " +
            imports.length +
            " import edges.",
        "",
        "### Entrypoint paths",
        ...(entryLines.length > 0
            ? [
                  "| Path | Function | Kind |",
                  "| --- | --- | --- |",
                  ...entryLines,
              ]
            : ["- No named entrypoint; use the file map below."]),
        "",
        "### End-to-end flow graph",
        ...(flowGraphLines.length > 0
            ? flowGraphLines
            : ["- No complete resolved function path was indexed."]),
        "### End-to-end function flow",
        ...(flowLines.length > 0
            ? flowLines
            : ["- No complete resolved function path was indexed."]),
        "",
        "### Indexed call edges",
        ...(callLines.length > 0
            ? callLines
            : ["- No resolved call edges were indexed."]),
        "",
        "### Import flow",
        ...(importLines.length > 0
            ? importLines
            : ["- No resolved import edges were indexed."]),
        "",
        "### Feature files",
        ...files.slice(0, MAX_FILES).map((file) => "- " + file.path),
    ].join("\n");
}
