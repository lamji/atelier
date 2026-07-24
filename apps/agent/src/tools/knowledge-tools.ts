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
