import type { Router } from "../bridge/router.js";
import type { HooksEngine } from "./hooks-engine.js";
import type { DbApprovalGuard } from "./db-approval-guard.js";

/**
 * hooks.* RPCs: the panel's list/save/delete plus the answer channel for
 * parked database operations.
 */
export function registerHookHandlers(
  router: Router,
  hooks: HooksEngine,
  dbApprovals: DbApprovalGuard
): void {
  router.register("hooks.list", () => ({ hooks: hooks.list() }));
  router.register("hooks.save", (params) => ({ hook: hooks.save(params.hook) }));
  router.register("hooks.delete", (params) => {
    hooks.delete(params.id);
    return {};
  });
  router.register("hooks.resolveApproval", (params) => ({
    ok: dbApprovals.resolve(params.id, params.approved),
  }));
}
