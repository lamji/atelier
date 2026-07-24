import type { PipelineStage } from "@atelier/protocol";

/** What each pipeline stage is called in live progress lines. */
export const STAGE_LABELS: Record<PipelineStage, string> = {
  understand: "understanding the request",
  retrieve: "retrieving knowledge",
  impact: "analyzing impact",
  plan: "planning",
  hooks: "checking hooks",
  execute: "working",
  validate: "validating changes",
  knowledge: "updating the index",
  review: "reviewing its own changes",
  summary: "summarizing",
};
