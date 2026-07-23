import type { Db } from "../../storage/db.js";
import type { EventBus } from "../../events/event-bus.js";

/**
 * Phase 5: incremental indexing pipeline. Dirty detection by content hash,
 * persistent index_jobs queue, per-file re-parse in workers, symbol diff by
 * stable_key, targeted edge re-resolution, delta re-embedding.
 */
export class IncrementalIndexer {
  constructor(
    private db: Db,
    private bus: EventBus
  ) {}

  async indexWorkspace(_force?: boolean): Promise<string> {
    return "job_not_implemented";
  }

  enqueueFile(_relPath: string, _priority = 0): void {
    // Implemented in Phase 5.
  }

  /** Awaited by pipeline stage 8 so knowledge is current before summary. */
  async drainFor(_paths: string[]): Promise<void> {}
}
