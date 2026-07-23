import type { Feature } from "@atelier/protocol";
import type { Db } from "../../storage/db.js";
import type { EventBus } from "../../events/event-bus.js";

/**
 * Phase 7: LLM-assisted feature models. Seeding clusters files via the
 * import graph; refresh re-summarizes only stale features, throttled so
 * background jobs never starve interactive tasks.
 */
export class FeatureModelService {
  constructor(
    private db: Db,
    private bus: EventBus
  ) {}

  list(): Feature[] {
    return [];
  }

  async seedFeatures(): Promise<void> {}

  async refreshStale(): Promise<void> {}

  markStaleForFiles(_paths: string[]): void {}
}
