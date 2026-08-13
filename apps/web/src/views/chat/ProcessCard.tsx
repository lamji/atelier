import { memo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ClipboardList, Loader2, Radar, XCircle } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { liveHeadline } from "@/lib/live-headline";
import { STAGE_LABELS } from "@/lib/stage-labels";
import { useElapsed } from "@/hooks/useElapsed";
import type { PipelineStage, Plan, PlanStep } from "@atelier/protocol";
import type { AgentAction } from "@/state/sessions.store";

export interface ProcessCardProps {
  plan: Plan | null;
  busy: boolean;
  actions: AgentAction[];
  stage: PipelineStage | null;
  startedAt: number | null;
  cancelling: boolean;
}

/**
 * The turn's process, inline in the transcript: the plan checklist and the
 * live action feed under one header.
 *
 * It sits in the message stream rather than in a side rail because that is
 * where the turn it describes is — the rail beside it now belongs to the
 * file changes, which need the width and the height a diff asks for and a
 * checklist does not.
 */
export const ProcessCard = memo(function ProcessCard(props: ProcessCardProps) {
  const headline = liveHeadline(props.actions, props.stage, props.cancelling);
  const elapsed = useElapsed(props.startedAt);
  const [expanded, setExpanded] = useState(false);
  // Everything still running is always visible — those are the rows that
  // answer "is it stuck". The finished ones are history, and a turn now
  // produces a lot of it, so they collapse behind a count until asked for.
  const running = props.actions.filter((a) => a.status === "running");
  const settled = props.actions.filter((a) => a.status !== "running");
  const shown = expanded
    ? props.actions
    : [...settled.slice(-RECENT_SETTLED), ...running];
  const hidden = props.actions.length - shown.length;

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="rounded-xl border border-border/50 bg-muted/40 px-3 py-2"
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        {props.busy ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        ) : (
          <Radar className="h-3.5 w-3.5 shrink-0 text-primary/70" />
        )}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[11px] font-semibold",
            "uppercase tracking-wider",
            props.busy ? "text-shimmer" : "text-muted-foreground"
          )}
        >
          {props.busy ? headline : "Process"}
        </span>
        {props.busy && props.startedAt !== null && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
          </span>
        )}
      </div>

      {props.busy && props.stage && running.length > 0 && (
        <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">
          {STAGE_LABELS[props.stage]}
        </p>
      )}

      {props.plan && <PlanSteps plan={props.plan} />}
      {props.busy && shown.length > 0 && (
        <>
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mb-1 text-[10px] text-muted-foreground/60 hover:text-foreground"
            >
              show {hidden} earlier step{hidden === 1 ? "" : "s"}
            </button>
          )}
          <ActionRows actions={shown} />
        </>
      )}
    </motion.div>
  );
});

/** Finished rows kept on screen when the feed is collapsed. */
const RECENT_SETTLED = 6;

/** The live task plan checklist (pipeline stage 4, updated by the model). */
const PlanSteps = memo(function PlanSteps({ plan }: { plan: Plan }) {
  const done = plan.steps.filter((s) => s.status === "done").length;
  return (
    <div className="mb-1.5">
      <div className="mb-1 flex items-center gap-1.5">
        <ClipboardList className="h-3 w-3 text-primary/70" />
        <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          Plan · {done}/{plan.steps.length}
        </span>
      </div>
      <div className="space-y-1">
        {plan.steps.map((step) => (
          <Tooltip key={step.id} content={step.detail} disabled={!step.detail}>
            <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <PlanStepIcon status={step.status} />
              <span
                className={cn(
                  "min-w-0 flex-1",
                  step.status === "done" && "line-through opacity-60",
                  step.status === "in-progress" && "text-foreground"
                )}
              >
                <span className="block break-words">{step.title}</span>
                {/*
                 * Same treatment as the action rows: these are file paths with
                 * no spaces to break at, so min-w-0 alone does not hold them —
                 * the flex item stops stretching but the text still runs past
                 * the card. break-all is what wraps them. Their own line,
                 * because a path reads as one unit rather than a tail on the
                 * sentence above it.
                 */}
                {step.files.length > 0 && (
                  <span className="mt-0.5 block break-all font-mono text-[10px] opacity-60">
                    {step.files.join(", ")}
                  </span>
                )}
              </span>
            </div>
          </Tooltip>
        ))}
      </div>
    </div>
  );
});

function PlanStepIcon({ status }: { status: PlanStep["status"] }) {
  if (status === "done") {
    return <Check className="mt-0.5 h-3 w-3 shrink-0 text-success" />;
  }
  if (status === "in-progress") {
    return (
      <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-primary" />
    );
  }
  if (status === "failed" || status === "cancelled") {
    return <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />;
  }
  return (
    <span className="mt-1 ml-0.5 mr-0.5 h-2 w-2 shrink-0 rounded-full border border-muted-foreground/40" />
  );
}

/** What the agent is doing, most recent last. Diffs are not in here any
 *  more — an edit is read in the changes rail, next to the other files. */
const ActionRows = memo(function ActionRows({
  actions,
}: {
  actions: AgentAction[];
}) {
  return (
    <div className="space-y-1.5">
      <AnimatePresence initial={false}>
        {actions.map((action) => (
          <motion.div
            key={action.id}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex items-start gap-1.5 text-[11px] text-muted-foreground"
          >
            {action.status === "running" ? (
              <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-primary/70" />
            ) : action.status === "done" ? (
              <Check className="mt-0.5 h-3 w-3 shrink-0 text-success" />
            ) : (
              <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
            )}
            {/*
             * Wrap instead of truncate: these labels are file paths, and the
             * part that identifies the file is the tail — exactly what an
             * ellipsis eats. break-all keeps long unbroken paths inside the
             * card instead of stretching it.
             */}
            <span className="min-w-0 flex-1">
              <span className="block break-all font-mono">{action.label}</span>
              {/*
               * The specifics the label dropped to stay a sentence — which
               * file, which pattern, which command. Dimmed and on its own
               * line so the feed still scans as a list of what happened,
               * with the detail there when a run goes somewhere odd.
               */}
              {action.detail && action.detail !== action.label && (
                <span className="mt-0.5 block break-all font-mono text-[10px] opacity-55">
                  {action.detail}
                </span>
              )}
              {action.status === "failed" && action.error && (
                <span className="mt-0.5 block break-all font-mono text-[10px] text-destructive">
                  {action.error}
                </span>
              )}
            </span>
            {/* Only when it was slow enough to be worth explaining. */}
            {action.durationMs !== undefined &&
              action.durationMs >= SLOW_TOOL_MS && (
                <span className="mt-0.5 shrink-0 text-[10px] tabular-nums opacity-50">
                  {formatDuration(action.durationMs)}
                </span>
              )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
});

/** Below this a duration is noise; above it, it is the reason for the wait. */
const SLOW_TOOL_MS = 1000;

function formatDuration(ms: number): string {
  return ms < 60_000
    ? `${(ms / 1000).toFixed(1)}s`
    : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}
