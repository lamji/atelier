import type { PipelineStage } from "@atelier/protocol";
import type { AgentAction } from "@/state/sessions.store";
import { STAGE_LABELS } from "./stage-labels";

/**
 * What the agent is doing right now, in one line: the running tool, else the
 * pipeline stage. Shared by the process card and the changes rail's empty
 * state so the two never disagree about the current step.
 */
export function liveHeadline(
  actions: AgentAction[],
  stage: PipelineStage | null,
  cancelling: boolean
): string {
  if (cancelling) return "stopping — finishing the current step";
  const running = actions.slice(-6).find((a) => a.status === "running");
  return running?.label ?? (stage ? STAGE_LABELS[stage] : "starting…");
}
