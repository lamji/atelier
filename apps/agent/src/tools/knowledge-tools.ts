import type { LessonKind } from "@atelier/protocol";
import type { ToolRegistry } from "./registry.js";
import type { Retriever } from "../rag/retriever.js";
import type { SymbolGraph } from "../knowledge/graph/symbol-graph.js";
import type { SymbolImpactAnalyzer } from "../knowledge/impact/symbol-impact.js";
import type { KnowledgeQuery } from "../knowledge/query/knowledge-query.js";
import type { LessonStore } from "../knowledge/lessons/lesson-store.js";
import type { EventBus } from "../events/event-bus.js";

interface RetrieveInput {
  query: string;
  k?: number;
  pathGlob?: string;
}

interface GraphInput {
  scope: "file" | "symbol" | "feature" | "workspace";
  target?: string;
  depth?: number;
}

interface SearchSymbolsInput {
  query: string;
  limit?: number;
}

interface SearchWorkspaceInput {
  query: string;
  glob?: string;
  maxResults?: number;
  /** Accepted for backward compat; index search is always semantic. */
  regex?: boolean;
}

interface SaveLessonInput {
  title: string;
  lesson: string;
  kind?: LessonKind;
  symbols?: string[];
  files?: string[];
}

interface AnalyzeImpactInput {
  files?: string[];
  symbols?: string[];
  depth?: number;
}

/**
 * Knowledge tools shared by the RPC router and the SDK (model) surface —
 * this is how the agent answers engineering questions from knowledge
 * instead of re-searching source.
 */
export function registerKnowledgeTools(
  registry: ToolRegistry,
  retriever: Retriever,
  graph: SymbolGraph,
  knowledge: KnowledgeQuery,
  lessons: LessonStore,
  symbolImpact: SymbolImpactAnalyzer,
  bus: EventBus
): void {
  registry.register("retrieve_knowledge", async (input: RetrieveInput) => {
    const filters = input.pathGlob ? { pathGlob: input.pathGlob } : undefined;
    return retriever.retrieve(input.query, input.k ?? 12, filters);
  });

  registry.register("query_knowledge_graph", async (input: GraphInput) => {
    return graph.graphFor(input.scope, input.target, input.depth ?? 1);
  });

  registry.register("search_symbols", async (input: SearchSymbolsInput) => {
    return knowledge.search(input.query, input.limit ?? 15);
  });

  // Workspace search now resolves through the live index instead of a
  // native filesystem scan — the engine knowledge stays synced to the
  // latest tree, so a query like "login" returns the files that actually
  // implement login, ranked by relevance, without re-reading the tree.
  registry.register(
    "search_workspace",
    async (input: SearchWorkspaceInput) => {
      const k = Math.min(Math.max(input.maxResults ?? 20, 1), 50);
      const filters = input.glob ? { pathGlob: input.glob } : undefined;
      // Over-fetch chunks so collapsing to one row per file still fills k.
      const result = await retriever.retrieve(input.query, k * 3, filters);
      const seen = new Set<string>();
      const matches = [];
      for (const chunk of result.chunks) {
        // File-backed hits only — lessons/feature summaries aren't files.
        if (chunk.kind !== "code" && chunk.kind !== "doc") continue;
        if (seen.has(chunk.path)) continue;
        seen.add(chunk.path);
        matches.push({
          path: chunk.path,
          row: chunk.startRow ?? 0,
          score: chunk.score,
          preview: firstLine(chunk.preview),
        });
        if (matches.length >= k) break;
      }
      return { matches, strategy: result.strategy };
    }
  );

  registry.register("save_lesson", async (input: SaveLessonInput, ctx) => {
    return lessons.save(input, ctx.taskId);
  });

  // Symbol/line-precise: what edits at this site would affect. The model
  // calls this BEFORE changing shared code to decide update-vs-isolate.
  registry.register(
    "impact_of_edit",
    async (
      input: { path: string; line?: number; symbol?: string },
      ctx
    ) => {
      const result = await symbolImpact.analyze(
        input.path,
        input.line,
        input.symbol
      );
      if (!result) {
        return {
          path: input.path,
          found: false,
          summary:
            "No indexed symbol at that location — the file may be new or " +
            "not yet parsed.",
        };
      }
      bus.publish("edit.impact", result, ctx.taskId);
      return result;
    }
  );

  registry.register("analyze_impact", async (input: AnalyzeImpactInput) => {
    // Symbols resolve to their defining files; impact is file-granular.
    const targets = new Set<string>(input.files ?? []);
    for (const name of (input.symbols ?? []).slice(0, 10)) {
      for (const sym of knowledge.byName(name, 3)) targets.add(sym.path);
    }
    const paths = [...targets];
    const direct = graph.dependentsOf(paths);
    const depth = Math.min(Math.max(input.depth ?? 1, 1), 3);
    // Transitive ripple: dependents of dependents, minus what we have.
    let frontier = direct.files;
    const transitive = new Set<string>();
    for (let d = 1; d < depth && frontier.length > 0; d++) {
      const next = graph.dependentsOf(frontier);
      frontier = next.files.filter(
        (f) => !targets.has(f) && !direct.files.includes(f) && !transitive.has(f)
      );
      for (const f of frontier) transitive.add(f);
    }
    return {
      targets: paths,
      directDependents: direct.files,
      affectedSymbols: direct.symbols,
      transitiveDependents: [...transitive],
      riskNotes: direct.lessons.map((l) => `${l.title}: ${l.body}`),
    };
  });
}

/** First non-empty line of a chunk preview, trimmed for a compact teaser. */
function firstLine(preview: string): string {
  const line = preview.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const trimmed = line.trim();
  return trimmed.length > 160 ? trimmed.slice(0, 160) + "…" : trimmed;
}
