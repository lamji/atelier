import type { GraphEdge, GraphNode, KnowledgeGraph } from "@atelier/protocol";
import type { Db } from "../../storage/db.js";

const MAX_NODES = 250;

/** Import/call/feature graph queries over the SQLite knowledge store. */
export class SymbolGraph {
  constructor(private db: Db) {}

  graphFor(
    scope: "file" | "symbol" | "feature" | "workspace",
    target?: string,
    depth = 1
  ): KnowledgeGraph {
    switch (scope) {
      case "workspace":
        return this.workspaceGraph();
      case "file":
        return this.fileGraph(target ?? "", Math.max(1, depth));
      case "symbol":
        return this.symbolGraph(target ?? "", Math.max(1, depth));
      case "feature":
        return this.featureGraph(target);
    }
  }

  /** File-level import graph of the whole workspace (bounded). */
  private workspaceGraph(): KnowledgeGraph {
    const files = this.db
      .prepare(
        "SELECT f.id, f.path, COUNT(s.id) AS syms FROM files f " +
          "LEFT JOIN symbols s ON s.file_id = f.id " +
          "WHERE f.parse_status = 'ok' GROUP BY f.id " +
          "ORDER BY syms DESC LIMIT ?"
      )
      .all(MAX_NODES) as Array<{ id: number; path: string; syms: number }>;
    const included = new Set(files.map((f) => f.id));
    const nodes: GraphNode[] = files.map((f) => ({
      id: `file:${f.id}`,
      label: f.path.split("/").pop() ?? f.path,
      kind: "file",
      path: f.path,
    }));
    const importRows = this.db
      .prepare(
        "SELECT file_id, resolved_file_id FROM imports " +
          "WHERE resolved_file_id IS NOT NULL"
      )
      .all() as Array<{ file_id: number; resolved_file_id: number }>;
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    for (const row of importRows) {
      if (!included.has(row.file_id) || !included.has(row.resolved_file_id)) {
        continue;
      }
      const key = `${row.file_id}>${row.resolved_file_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: `file:${row.file_id}`,
        target: `file:${row.resolved_file_id}`,
        kind: "import",
      });
    }
    return { nodes, edges };
  }

  /**
   * One file, symbol-level: the target file and its import neighbors are
   * rendered as containers with their functions INSIDE, and edges connect
   * the actual symbols across files — "file A uses function X from
   * file B" is a line from A's caller into X inside B's box.
   */
  private fileGraph(targetPath: string, _depth: number): KnowledgeGraph {
    const file = this.db
      .prepare("SELECT id, path FROM files WHERE path = ? COLLATE NOCASE")
      .get(targetPath) as { id: number; path: string } | undefined;
    if (!file) return { nodes: [], edges: [] };

    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const addGroup = (fileId: number, path: string): string => {
      const key = `file:${fileId}`;
      if (!nodes.has(key)) {
        nodes.set(key, { id: key, label: path, kind: "file", path });
      }
      return key;
    };
    const addSym = (row: SymbolRow): string => {
      const key = `sym:${row.id}`;
      if (!nodes.has(key)) {
        nodes.set(key, {
          id: key,
          label: row.name,
          kind: row.kind,
          path: row.path,
          parentId: addGroup(row.fileId, row.path),
        });
      }
      return key;
    };
    addGroup(file.id, file.path);

    // All top-level symbols of the target file.
    const targetSyms = this.db
      .prepare(
        "SELECT s.id, s.name, s.kind, f.path, f.id AS fileId FROM symbols s " +
          "JOIN files f ON f.id = s.file_id " +
          "WHERE s.file_id = ? AND s.parent_symbol_id IS NULL LIMIT 40"
      )
      .all(file.id) as SymbolRow[];
    const targetSymIds = new Set<number>();
    for (const sym of targetSyms) {
      targetSymIds.add(sym.id);
      addSym(sym);
    }

    // Cross-file call edges touching the target file — the real
    // function-to-function connections.
    const linkedSymIds = new Set<number>();
    const callRows = this.db
      .prepare(
        `SELECT caller.id AS aId, caller.name AS aName, caller.kind AS aKind,
                af.path AS aPath, af.id AS aFileId,
                callee.id AS bId, callee.name AS bName, callee.kind AS bKind,
                bf.path AS bPath, bf.id AS bFileId
         FROM call_edges ce
         JOIN symbols caller ON caller.id = ce.caller_symbol_id
         JOIN files af ON af.id = caller.file_id
         JOIN symbols callee ON callee.id = ce.callee_symbol_id
         JOIN files bf ON bf.id = callee.file_id
         WHERE (caller.file_id = ? OR callee.file_id = ?)
           AND caller.file_id != callee.file_id
         LIMIT 120`
      )
      .all(file.id, file.id) as Array<{
      aId: number; aName: string; aKind: string; aPath: string; aFileId: number;
      bId: number; bName: string; bKind: string; bPath: string; bFileId: number;
    }>;
    for (const row of callRows) {
      if (nodes.size >= MAX_NODES) break;
      const src = addSym({
        id: row.aId, name: row.aName, kind: row.aKind,
        path: row.aPath, fileId: row.aFileId,
      });
      const dst = addSym({
        id: row.bId, name: row.bName, kind: row.bKind,
        path: row.bPath, fileId: row.bFileId,
      });
      linkedSymIds.add(row.aId);
      linkedSymIds.add(row.bId);
      edges.push({ source: src, target: dst, kind: "call" });
    }

    // Imported symbols with no call edge (components used in JSX, values,
    // re-exports): show them inside their home file, linked from the
    // importing file's box.
    const importRows = this.db
      .prepare(
        `SELECT i.file_id AS fromId, i.resolved_file_id AS toId,
                i.imported_names AS names
         FROM imports i
         WHERE (i.file_id = ? OR i.resolved_file_id = ?)
           AND i.resolved_file_id IS NOT NULL AND i.is_type_only = 0`
      )
      .all(file.id, file.id) as Array<{
      fromId: number; toId: number; names: string | null;
    }>;
    const findSym = this.db.prepare(
      "SELECT s.id, s.name, s.kind, f.path, f.id AS fileId FROM symbols s " +
        "JOIN files f ON f.id = s.file_id " +
        "WHERE s.file_id = ? AND s.name = ? AND s.parent_symbol_id IS NULL " +
        "LIMIT 1"
    );
    const filePath = this.db.prepare("SELECT path FROM files WHERE id = ?");
    for (const row of importRows) {
      if (nodes.size >= MAX_NODES) break;
      let names: string[] = [];
      try {
        names = row.names ? (JSON.parse(row.names) as string[]) : [];
      } catch {
        names = [];
      }
      const fromPath = (filePath.get(row.fromId) as { path: string } | undefined)
        ?.path;
      if (!fromPath) continue;
      const fromKey = addGroup(row.fromId, fromPath);
      for (const name of names.slice(0, 12)) {
        const sym = findSym.get(row.toId, name) as SymbolRow | undefined;
        if (!sym) continue;
        if (linkedSymIds.has(sym.id)) continue; // call edge already shows it
        const dst = addSym(sym);
        edges.push({ source: fromKey, target: dst, kind: "import" });
      }
    }

    this.attachLessonNodes(nodes, edges, [file.id]);
    return { nodes: [...nodes.values()], edges: dedupeEdges(edges) };
  }

  /**
   * One symbol (by numeric id or name): callers and callees to depth,
   * each nested inside its file's container so cross-file flows are
   * visible at a glance.
   */
  private symbolGraph(target: string, depth: number): KnowledgeGraph {
    const root = /^\d+$/.test(target)
      ? (this.db
          .prepare(
            "SELECT s.id, s.name, s.kind, f.path, f.id AS fileId " +
              "FROM symbols s " +
              "JOIN files f ON f.id = s.file_id WHERE s.id = ?"
          )
          .get(Number(target)) as SymbolRow | undefined)
      : (this.db
          .prepare(
            "SELECT s.id, s.name, s.kind, f.path, f.id AS fileId " +
              "FROM symbols s " +
              "JOIN files f ON f.id = s.file_id WHERE s.name = ? " +
              "ORDER BY s.id LIMIT 1"
          )
          .get(target) as SymbolRow | undefined);
    if (!root) return { nodes: [], edges: [] };

    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const add = (row: SymbolRow) => {
      const groupKey = `file:${row.fileId}`;
      if (!nodes.has(groupKey)) {
        nodes.set(groupKey, {
          id: groupKey,
          label: row.path,
          kind: "file",
          path: row.path,
        });
      }
      const key = `sym:${row.id}`;
      if (!nodes.has(key)) {
        nodes.set(key, {
          id: key,
          label: row.name,
          kind: row.kind,
          path: row.path,
          parentId: groupKey,
        });
      }
      return key;
    };
    add(root);

    let frontier = [root.id];
    const visited = new Set(frontier);
    for (let d = 0; d < depth && nodes.size < MAX_NODES; d++) {
      const nextFrontier: number[] = [];
      for (const symId of frontier) {
        const callees = this.db
          .prepare(
            "SELECT s.id, s.name, s.kind, f.path, f.id AS fileId " +
              "FROM call_edges ce " +
              "JOIN symbols s ON s.id = ce.callee_symbol_id " +
              "JOIN files f ON f.id = s.file_id WHERE ce.caller_symbol_id = ?"
          )
          .all(symId) as SymbolRow[];
        const callers = this.db
          .prepare(
            "SELECT s.id, s.name, s.kind, f.path, f.id AS fileId " +
              "FROM call_edges ce " +
              "JOIN symbols s ON s.id = ce.caller_symbol_id " +
              "JOIN files f ON f.id = s.file_id WHERE ce.callee_symbol_id = ?"
          )
          .all(symId) as SymbolRow[];
        for (const row of callees) {
          edges.push({ source: `sym:${symId}`, target: add(row), kind: "call" });
          if (!visited.has(row.id)) {
            visited.add(row.id);
            nextFrontier.push(row.id);
          }
        }
        for (const row of callers) {
          edges.push({ source: add(row), target: `sym:${symId}`, kind: "call" });
          if (!visited.has(row.id)) {
            visited.add(row.id);
            nextFrontier.push(row.id);
          }
        }
      }
      frontier = nextFrontier;
    }

    this.attachLessonsToSymbols(nodes, edges, [...visited]);
    return { nodes: [...nodes.values()], edges: dedupeEdges(edges) };
  }

  /** Lessons anchored (by stable_key) to any of the given symbol ids. */
  private attachLessonsToSymbols(
    nodes: Map<string, GraphNode>,
    edges: GraphEdge[],
    symbolIds: number[]
  ): void {
    if (symbolIds.length === 0) return;
    const placeholders = symbolIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT DISTINCT l.id, l.title, s.id AS symId
         FROM lessons l
         JOIN lesson_links ll ON ll.lesson_id = l.id
         JOIN symbols s ON s.stable_key = ll.stable_key
         WHERE s.id IN (${placeholders}) LIMIT 20`
      )
      .all(...symbolIds) as Array<{ id: number; title: string; symId: number }>;
    for (const row of rows) {
      const key = `lesson:${row.id}`;
      if (!nodes.has(key)) {
        nodes.set(key, { id: key, label: row.title, kind: "lesson" });
      }
      edges.push({ source: key, target: `sym:${row.symId}`, kind: "lesson" });
    }
  }

  /** Lessons anchored (by file_path or symbol stable_key) to these files. */
  private attachLessonNodes(
    nodes: Map<string, GraphNode>,
    edges: GraphEdge[],
    fileIds: number[]
  ): void {
    if (fileIds.length === 0) return;
    const placeholders = fileIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT DISTINCT l.id, l.title, f.id AS fileId
         FROM lessons l
         JOIN lesson_links ll ON ll.lesson_id = l.id
         JOIN files f ON (
           f.path = ll.file_path COLLATE NOCASE
           OR f.id IN (SELECT file_id FROM symbols WHERE stable_key = ll.stable_key)
         )
         WHERE f.id IN (${placeholders}) LIMIT 20`
      )
      .all(...fileIds) as Array<{ id: number; title: string; fileId: number }>;
    for (const row of rows) {
      const key = `lesson:${row.id}`;
      if (!nodes.has(key)) {
        nodes.set(key, { id: key, label: row.title, kind: "lesson" });
      }
      edges.push({ source: key, target: `file:${row.fileId}`, kind: "lesson" });
    }
  }

  private featureGraph(target?: string): KnowledgeGraph {
    const features = target
      ? (this.db
          .prepare("SELECT id, name, slug FROM features WHERE slug = ?")
          .all(target) as FeatureRow[])
      : (this.db
          .prepare("SELECT id, name, slug FROM features LIMIT 30")
          .all() as FeatureRow[]);
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (const feature of features) {
      const fKey = `feature:${feature.id}`;
      nodes.push({ id: fKey, label: feature.name, kind: "feature" });
      const files = this.db
        .prepare(
          "SELECT f.id, f.path FROM feature_files ff " +
            "JOIN files f ON f.id = ff.file_id WHERE ff.feature_id = ? LIMIT 40"
        )
        .all(feature.id) as Array<{ id: number; path: string }>;
      for (const file of files) {
        const key = `file:${file.id}`;
        if (!nodes.some((n) => n.id === key)) {
          nodes.push({
            id: key,
            label: file.path.split("/").pop() ?? file.path,
            kind: "file",
            path: file.path,
          });
        }
        edges.push({ source: fKey, target: key, kind: "feature" });
      }
    }
    return { nodes, edges };
  }

  /**
   * Files/symbols that depend on the given files, plus lessons anchored
   * to them (impact analysis — Phase 6 stage 3 feeds `lessons` into
   * riskNotes so past mistakes warn future tasks).
   */
  dependentsOf(paths: string[]): {
    files: string[];
    symbols: string[];
    lessons: Array<{ title: string; body: string }>;
  } {
    const files = new Set<string>();
    const symbols = new Set<string>();
    for (const relPath of paths) {
      const file = this.db
        .prepare("SELECT id FROM files WHERE path = ? COLLATE NOCASE")
        .get(relPath) as { id: number } | undefined;
      if (!file) continue;
      const importers = this.db
        .prepare(
          "SELECT f.path FROM imports i JOIN files f ON f.id = i.file_id " +
            "WHERE i.resolved_file_id = ?"
        )
        .all(file.id) as Array<{ path: string }>;
      for (const row of importers) files.add(row.path);
      const callers = this.db
        .prepare(
          "SELECT DISTINCT cs.name AS name, cf.path AS path FROM call_edges ce " +
            "JOIN symbols callee ON callee.id = ce.callee_symbol_id " +
            "JOIN symbols cs ON cs.id = ce.caller_symbol_id " +
            "JOIN files cf ON cf.id = cs.file_id " +
            "WHERE callee.file_id = ? AND cs.file_id != ?"
        )
        .all(file.id, file.id) as Array<{ name: string; path: string }>;
      for (const row of callers) {
        files.add(row.path);
        symbols.add(`${row.path}::${row.name}`);
      }
    }
    for (const p of paths) files.delete(p);

    const lessons: Array<{ title: string; body: string }> = [];
    if (paths.length > 0) {
      const placeholders = paths.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT DISTINCT l.title, l.body_md FROM lessons l
           JOIN lesson_links ll ON ll.lesson_id = l.id
           WHERE ll.file_path IN (${placeholders}) COLLATE NOCASE
              OR ll.stable_key IN (
                SELECT s.stable_key FROM symbols s
                JOIN files f ON f.id = s.file_id
                WHERE f.path IN (${placeholders}) COLLATE NOCASE
              )
           LIMIT 5`
        )
        .all(...paths, ...paths) as Array<{ title: string; body_md: string }>;
      for (const row of rows) lessons.push({ title: row.title, body: row.body_md });
    }
    return { files: [...files], symbols: [...symbols], lessons };
  }
}

interface SymbolRow {
  id: number;
  name: string;
  kind: string;
  path: string;
  fileId: number;
}

interface FeatureRow {
  id: number;
  name: string;
  slug: string;
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const key = `${e.source}>${e.target}:${e.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
