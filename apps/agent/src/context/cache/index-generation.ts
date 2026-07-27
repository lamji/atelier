import type { EventBus } from "../../events/event-bus.js";

/**
 * Monotonic index generation: bumps on every knowledge.updated event.
 * Cache keys embed the generation, so any reindex of any file invalidates
 * retrieval-result entries without explicit eviction bookkeeping.
 */
export class IndexGeneration {
  private generation = 0;

  constructor(bus: EventBus) {
    bus.subscribe((event) => {
      if (event.topic === "knowledge.updated") this.generation += 1;
    });
  }

  get current(): number {
    return this.generation;
  }
}
