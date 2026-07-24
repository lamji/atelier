import type { Router } from "./bridge/router.js";
import type { KnowledgeQuery } from "./knowledge/query/knowledge-query.js";
import type { IncrementalIndexer } from "./knowledge/indexer/incremental-indexer.js";
import type { SymbolGraph } from "./knowledge/graph/symbol-graph.js";
import type { FeatureModelService } from "./knowledge/features/feature-model.js";
import type { RouteFeatureScanner } from "./knowledge/features/route-feature-scanner.js";
import type { LessonStore } from "./knowledge/lessons/lesson-store.js";
import type { Retriever } from "./rag/retriever.js";
import type { ValidationRunners } from "./validation/runners.js";
import type { EventBus } from "./events/event-bus.js";
import type { SettingsRepo } from "./storage/repositories/settings.js";

/**
 * Wires RPC handlers that are already real in Phase 1. Everything not
 * registered here (fs.*, terminal.*, git.*, ...) answers NOT_IMPLEMENTED
 * from the router until its phase lands.
 */
export function registerMiscHandlers(
  router: Router,
  knowledge: KnowledgeQuery,
  indexer: IncrementalIndexer,
  retriever: Retriever,
  graph: SymbolGraph,
  features: FeatureModelService,
  routeFeatures: RouteFeatureScanner,
  lessons: LessonStore,
  validators: ValidationRunners,
  bus: EventBus,
  settings: SettingsRepo
): void {
  const runValidation = async (
    kind: "lint" | "test" | "typecheck"
  ): Promise<{ result: import("@atelier/protocol").ValidationResult }> => {
    bus.publish("validation.started", { kind });
    const result = await validators.run(kind);
    bus.publish("validation.result", result);
    return { result };
  };
  router.register("lint.run", () => runValidation("lint"));
  router.register("tests.run", () => runValidation("test"));
  router.register("typecheck.run", () => runValidation("typecheck"));

  router.register("knowledge.stats", () => ({ stats: knowledge.stats() }));
  router.register("knowledge.indexWorkspace", async (params) => ({
    jobId: await indexer.indexWorkspace(params?.force ?? false),
  }));
  router.register("knowledge.retrieve", async (params) => ({
    result: await retriever.retrieve(params.query, params.k, params.filters),
  }));
  router.register("knowledge.graph", (params) => ({
    graph: graph.graphFor(params.scope, params.target, params.depth),
  }));
  router.register("knowledge.features.list", () => ({
    features: features.list(),
  }));
  router.register("knowledge.features.scan", () => routeFeatures.start());
  router.register("knowledge.lessons.list", (params) => ({
    lessons: lessons.list(params?.limit ?? 50),
  }));
  router.register("knowledge.symbol", (params) => ({
    symbol: knowledge.symbol(params.id),
  }));

  router.register("settings.get", () => ({ settings: settings.get() }));
  router.register("settings.save", (params) => ({
    settings: settings.save(params.settings),
  }));
}
