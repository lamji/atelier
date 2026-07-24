import type { ImpactFlow, ImpactNode, ImpactRadius } from "@atelier/protocol";
import type { Db } from "../../storage/db.js";
import type { SymbolGraph } from "../graph/symbol-graph.js";
import { companionFilesFor } from "./companion-files.js";

/** How far up the reverse-dependency chain to walk (child-of-child callers). */
const MAX_DEPTH = 3;
/** Cap so a hub file (utils, types) can't produce a thousand-node radius. */
const MAX_AFFECTED = 60;

/** Symbol kinds that represent an entry point / user-facing flow. */
const FLOW_KINDS = new Set(["component", "route", "hook"]);
const TEST_RE = /\.(spec|test)\.[tj]sx?$/i;

interface FileRow {
  id: number;
  path: string;
}

/**
 * Computes the blast radius of an upcoming edit BEFORE it happens: who
 * calls or imports the target files (transitively — the "child process"
 * chain), which downstream flows ride on them, which tests exercise them,
 * and how exposed the change is to regressions.
 *
 * The dependency graph only records edges that resolved, so this is a
 * lower bound — it never invents reach, but dynamic dispatch it could not
 * resolve stays invisible. The regression level reflects that honestly.
 */
export class ImpactAnalyzer {
  constructor(
    private db: Db,
    private graph: SymbolGraph,
    private workspaceRoot: string
  ) {}

  analyze(targetPaths: string[]): ImpactRadius {
    const targets = [...new Set(targetPaths.map(norm))].filter(Boolean);
    if (targets.length === 0) return empty(targets);

    const affected = this.walkReverseDeps(targets);
    const affectedPaths = new Set(affected.map((a) => a.path));
    const flows = this.flowsAmong([...affectedPaths]);
    const testsAtRisk = this.testsFor(targets, affectedPaths);
    const companions = companionFilesFor(this.workspaceRoot, targets).filter(
      (f) => !TEST_RE.test(f) // spec companions already covered by tests
    );
    const { lessons } = this.graph.dependentsOf(targets);
    const risks = lessons.slice(0, 5);

    const level = regressionLevel({
      affected: affected.length,
      flows: flows.length,
      tests: testsAtRisk.length,
      risks: risks.length,
    });
    return {
      targets,
      affected: affected.slice(0, MAX_AFFECTED),
      flows,
      testsAtRisk,
      companions,
      risks,
      level,
      summary: summarize(targets, affected, flows, testsAtRisk, level),
    };
  }

  /** BFS up call + import reverse edges, tagging each hop with its depth. */
  private walkReverseDeps(targets: string[]): ImpactNode[] {
    const startIds = this.fileIds(targets);
    if (startIds.length === 0) return [];

    const out: ImpactNode[] = [];
    const seenFiles = new Set(startIds);
    const seenSymbols = new Set<number>();
    let frontier = startIds;

    for (let depth = 1; depth <= MAX_DEPTH && out.length < MAX_AFFECTED; depth++) {
      const next = new Set<number>();
      for (const fileId of frontier) {
        // Behavioural reach: symbols in OTHER files that call into this one.
        for (const row of this.callersOf(fileId)) {
          if (seenSymbols.has(row.callerId)) continue;
          seenSymbols.add(row.callerId);
          out.push({
            path: row.path,
            symbol: row.name,
            kind: row.kind,
            depth,
            via: "call",
          });
          next.add(row.callerFileId);
          if (out.length >= MAX_AFFECTED) break;
        }
        // Structural reach: files that import this one.
        for (const row of this.importersOf(fileId)) {
          if (seenFiles.has(row.id)) continue;
          out.push({ path: row.path, depth, via: "import" });
          next.add(row.id);
          if (out.length >= MAX_AFFECTED) break;
        }
      }
      for (const id of next) seenFiles.add(id);
      frontier = [...next];
      if (frontier.length === 0) break;
    }
    return out;
  }

  private fileIds(paths: string[]): number[] {
    const ids: number[] = [];
    const stmt = this.db.prepare(
      "SELECT id FROM files WHERE path = ? COLLATE NOCASE"
    );
    for (const path of paths) {
      const row = stmt.get(path) as { id: number } | undefined;
      if (row) ids.push(row.id);
    }
    return ids;
  }

  /** Cross-file callers of any symbol defined in `fileId`. */
  private callersOf(fileId: number): Array<{
    callerId: number;
    callerFileId: number;
    name: string;
    kind: string;
    path: string;
  }> {
    return this.db
      .prepare(
        "SELECT DISTINCT cs.id AS callerId, cs.file_id AS callerFileId, " +
          "cs.name AS name, cs.kind AS kind, cf.path AS path " +
          "FROM call_edges ce " +
          "JOIN symbols callee ON callee.id = ce.callee_symbol_id " +
          "JOIN symbols cs ON cs.id = ce.caller_symbol_id " +
          "JOIN files cf ON cf.id = cs.file_id " +
          "WHERE callee.file_id = ? AND cs.file_id != ? LIMIT 40"
      )
      .all(fileId, fileId) as never;
  }

  /** Files that import `fileId` (structural dependents). */
  private importersOf(fileId: number): FileRow[] {
    return this.db
      .prepare(
        "SELECT DISTINCT f.id, f.path FROM imports i " +
          "JOIN files f ON f.id = i.file_id " +
          "WHERE i.resolved_file_id = ? LIMIT 40"
      )
      .all(fileId) as FileRow[];
  }

  /** Routes/components/hooks + named features among the affected files. */
  private flowsAmong(paths: string[]): ImpactFlow[] {
    if (paths.length === 0) return [];
    const placeholders = paths.map(() => "?").join(",");
    const flows: ImpactFlow[] = [];

    const entries = this.db
      .prepare(
        "SELECT DISTINCT s.name, s.kind, f.path FROM symbols s " +
          "JOIN files f ON f.id = s.file_id " +
          `WHERE f.path IN (${placeholders}) COLLATE NOCASE ` +
          "AND s.kind IN ('component','route','hook') " +
          "AND s.parent_symbol_id IS NULL LIMIT 20"
      )
      .all(...paths) as Array<{ name: string; kind: string; path: string }>;
    for (const e of entries) {
      if (FLOW_KINDS.has(e.kind)) {
        flows.push({ name: e.name, path: e.path, kind: e.kind });
      }
    }

    const features = this.db
      .prepare(
        "SELECT DISTINCT ft.name FROM feature_files ff " +
          "JOIN features ft ON ft.id = ff.feature_id " +
          "JOIN files f ON f.id = ff.file_id " +
          `WHERE f.path IN (${placeholders}) COLLATE NOCASE LIMIT 12`
      )
      .all(...paths) as Array<{ name: string }>;
    for (const ft of features) flows.push({ name: ft.name, kind: "feature" });
    return flows;
  }

  /** Test/spec files that import the targets or any affected file. */
  private testsFor(targets: string[], affected: Set<string>): string[] {
    const reach = [...new Set([...targets, ...affected])];
    const fromImports = new Set<string>();
    const ids = this.fileIds(reach);
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          "SELECT DISTINCT f.path FROM imports i " +
            "JOIN files f ON f.id = i.file_id " +
            `WHERE i.resolved_file_id IN (${placeholders}) LIMIT 60`
        )
        .all(...ids) as Array<{ path: string }>;
      for (const row of rows) {
        if (TEST_RE.test(row.path)) fromImports.add(row.path);
      }
    }
    // Name-adjacent specs (foo.spec.ts next to foo.ts) even without an
    // import edge — a rename/deletion still breaks them.
    for (const target of targets) {
      const spec = target.replace(/\.([tj]sx?)$/i, ".spec.$1");
      const test = target.replace(/\.([tj]sx?)$/i, ".test.$1");
      for (const candidate of [spec, test]) {
        const row = this.db
          .prepare("SELECT path FROM files WHERE path = ? COLLATE NOCASE")
          .get(candidate) as { path: string } | undefined;
        if (row) fromImports.add(row.path);
      }
    }
    return [...fromImports];
  }
}

function empty(targets: string[]): ImpactRadius {
  return {
    targets,
    affected: [],
    flows: [],
    testsAtRisk: [],
    companions: [],
    risks: [],
    level: "low",
    summary: "No indexed reach for the target files.",
  };
}

/** Fan-out + risk signals rolled into a coarse regression exposure. */
function regressionLevel(s: {
  affected: number;
  flows: number;
  tests: number;
  risks: number;
}): "low" | "medium" | "high" {
  const score = s.affected + s.flows * 3 + s.risks * 4 - s.tests;
  if (score >= 24 || s.risks >= 2) return "high";
  if (score >= 8 || s.flows >= 1) return "medium";
  return "low";
}

function summarize(
  targets: string[],
  affected: ImpactNode[],
  flows: ImpactFlow[],
  tests: string[],
  level: string
): string {
  const parts = [
    `${affected.length} caller/importer${affected.length === 1 ? "" : "s"}`,
  ];
  if (flows.length > 0) parts.push(`${flows.length} flow(s)`);
  if (tests.length > 0) parts.push(`${tests.length} test(s) at risk`);
  return `${level.toUpperCase()} regression risk — ${parts.join(", ")}.`;
}

function norm(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}
