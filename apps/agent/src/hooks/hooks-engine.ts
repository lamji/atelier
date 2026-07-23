import type { HookConfig } from "@atelier/protocol";
import type { Db } from "../storage/db.js";
import type { EventBus } from "../events/event-bus.js";

export interface HookDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Phase 6: evaluates user-configured hooks at pipeline stages and around
 * tool calls (wired into the SDK canUseTool / PostToolUse callbacks).
 */
export class HooksEngine {
  constructor(
    private db: Db,
    private bus: EventBus
  ) {}

  list(): HookConfig[] {
    const rows = this.db
      .prepare("SELECT config FROM hook_configs")
      .all() as Array<{ config: string }>;
    return rows.map((r) => JSON.parse(r.config) as HookConfig);
  }

  save(hook: HookConfig): HookConfig {
    this.db
      .prepare(
        "INSERT INTO hook_configs(id, config, enabled) VALUES(?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET config = excluded.config, " +
          "enabled = excluded.enabled"
      )
      .run(hook.id, JSON.stringify(hook), hook.enabled ? 1 : 0);
    return hook;
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM hook_configs WHERE id = ?").run(id);
  }

  /** Phase 6: evaluate preTool hooks. Allows everything until implemented. */
  async evaluateToolUse(
    _toolName: string,
    _input: unknown,
    _taskId: string
  ): Promise<HookDecision> {
    return { allowed: true };
  }
}
