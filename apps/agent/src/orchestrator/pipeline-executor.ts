import { PIPELINE_STAGES, type PipelineStage } from "@atelier/protocol";
import type { EventBus } from "../events/event-bus.js";

/**
 * Phase 6: the 9-stage state machine. Every task runs all stages in order —
 * none may be skipped — with stage events published around each. Until then
 * the orchestrator calls the SDK directly; this class defines the frame.
 */
export class PipelineExecutor {
  constructor(private bus: EventBus) {}

  stages(): readonly PipelineStage[] {
    return PIPELINE_STAGES;
  }

  async run(_taskId: string, _prompt: string): Promise<void> {
    throw new Error("PipelineExecutor lands in Phase 6");
  }
}
