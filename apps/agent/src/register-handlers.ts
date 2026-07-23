import type { Router } from "./bridge/router.js";
import type { HooksEngine } from "./hooks/hooks-engine.js";
import type { KnowledgeQuery } from "./knowledge/query/knowledge-query.js";
import type { SettingsRepo } from "./storage/repositories/settings.js";

/**
 * Wires RPC handlers that are already real in Phase 1. Everything not
 * registered here (fs.*, terminal.*, git.*, ...) answers NOT_IMPLEMENTED
 * from the router until its phase lands.
 */
export function registerMiscHandlers(
  router: Router,
  hooks: HooksEngine,
  knowledge: KnowledgeQuery,
  settings: SettingsRepo
): void {
  router.register("hooks.list", () => ({ hooks: hooks.list() }));
  router.register("hooks.save", (params) => ({ hook: hooks.save(params.hook) }));
  router.register("hooks.delete", (params) => {
    hooks.delete(params.id);
    return {};
  });

  router.register("knowledge.stats", () => ({ stats: knowledge.stats() }));

  router.register("settings.get", () => ({ settings: settings.get() }));
  router.register("settings.save", (params) => ({
    settings: settings.save(params.settings),
  }));
}
