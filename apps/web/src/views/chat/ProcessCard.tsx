import { memo, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  BookOpen,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  FileCheck2,
  Loader2,
  Maximize2,
  Radar,
  FolderLock,
  History,
  MessageSquareText,
  Network,
  Send,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { liveHeadline } from "@/lib/live-headline";
import { STAGE_LABELS } from "@/lib/stage-labels";
import { useElapsed } from "@/hooks/useElapsed";
import { UnifiedDiffView } from "./UnifiedDiffView";
import type { PipelineStage, Plan, PlanStep } from "@atelier/protocol";
import type { AgentAction, LiveDiff } from "@/state/sessions.store";
import type { ChatItemVm } from "@/types";

export interface ProcessCardProps {
  title?: string;
  request: string;
  report: string;
  images?: string[];
  frontendReview?: boolean;
  requestedAt: number | null;
  plan: Plan | null;
  busy: boolean;
  actions: AgentAction[];
  diffs: LiveDiff[];
  stage: PipelineStage | null;
  startedAt: number | null;
  durationMs?: number | null;
  cancelling: boolean;
  logs: ChatItemVm[];
  thinking: string;
  status: string;
  /** Summarises the final report behind "Show more" in the preview sidebar. */
  compact?: boolean;
}

/**
 * The turn's process, inline in the transcript: the plan flow and the live
 * action feed under one header.
 *
 * It sits in the message stream because that is where the turn it describes
 * is. Each step owns its tool evidence and file diffs in an accordion, so a
 * completed run remains reviewable without leaving the conversation.
 */
export const ProcessCard = memo(function ProcessCard(props: ProcessCardProps) {
  const headline = liveHeadline(props.actions, props.stage, props.cancelling);
  const elapsed = useElapsed(props.startedAt);
  const [openSteps, setOpenSteps] = useState<string[]>([]);
  const running = props.actions.filter((a) => a.status === "running");
  const liveStepId = props.plan?.steps.find(
    (step) => step.status === "in-progress"
  )?.id;

  useEffect(() => {
    if (!liveStepId) return;
    setOpenSteps((current) =>
      current.includes(liveStepId) ? current : [...current, liveStepId]
    );
  }, [liveStepId]);

  const toggleStep = (stepId: string) =>
    setOpenSteps((current) =>
      current.includes(stepId)
        ? current.filter((id) => id !== stepId)
        : [...current, stepId]
    );

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="overflow-hidden rounded-2xl bg-card"
    >
      <div className="flex items-center gap-2 border-b border-border/70 bg-muted/35 px-4 py-3">
        <span className="icon-tile icon-tile-sm">
          {props.busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Radar className="h-3.5 w-3.5" />
          )}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider",
            props.busy ? "text-shimmer" : "text-muted-foreground"
          )}
        >
          {props.title ?? `Request · ${formatRequestTime(props.requestedAt)}`}
        </span>
        {props.busy && (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {headline}
          </span>
        )}
        {props.busy && props.startedAt !== null && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
          </span>
        )}
        {!props.busy && props.startedAt !== null && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
            {props.durationMs !== null && props.durationMs !== undefined
              ? formatDuration(props.durationMs)
              : formatDuration(props.startedAt === 0 ? 0 : Date.now() - props.startedAt)}
          </span>
        )}
      </div>

      <div className="px-4 py-3">
        {props.busy && props.stage && running.length > 0 && (
          <p className="mb-2 text-[11px] text-muted-foreground/60">
            {STAGE_LABELS[props.stage]}
          </p>
        )}

        <WorkflowTimeline
          request={props.request}
          report={props.report}
          images={props.images ?? []}
          frontendReview={props.frontendReview ?? false}
          requestedAt={props.requestedAt}
          plan={props.plan}
          logs={props.logs}
          busy={props.busy}
          thinking={props.thinking}
          status={props.status}
          actions={props.actions}
          diffs={props.diffs}
          compact={props.compact === true}
          openSteps={openSteps}
          onToggleStep={toggleStep}
        />
      </div>
    </motion.div>
  );
});

/**
 * The live task plan (pipeline stage 4, updated by the model), drawn as a
 * vertical flow rather than a checklist.
 *
 * A plan is a sequence — each step only starts once the one above it is done —
 * and a flat list of ticks says nothing about that ordering. The connector
 * carries the progress: it is solid behind everything already completed and
 * fades out below the step in flight, so the position of the live node in the
 * run is readable at a glance, without counting rows.
 */
const WorkflowTimeline = memo(function WorkflowTimeline({
  request,
  report,
  images,
  frontendReview,
  requestedAt,
  plan,
  logs,
  busy,
  thinking,
  status,
  actions,
  diffs,
  compact,
  openSteps,
  onToggleStep,
}: {
  request: string;
  report: string;
  images: string[];
  frontendReview: boolean;
  requestedAt: number | null;
  plan: Plan | null;
  logs: ChatItemVm[];
  busy: boolean;
  thinking: string;
  status: string;
  actions: AgentAction[];
  diffs: LiveDiff[];
  compact: boolean;
  openSteps: string[];
  onToggleStep: (stepId: string) => void;
}) {
  const steps = plan?.steps ?? [];
  const done = steps.filter((step) => step.status === "done").length;
  const unassignedActions = actions.filter((action) => !action.stepId);
  const unassignedDiffs = diffs.filter((diff) => !diff.stepId);
  const hasPreparation = unassignedActions.length > 0;
  const hasUnplannedEdits = unassignedDiffs.length > 0;
  const frontendReviewPassed = /FRONTEND REVIEW:\s*PASS\b/i.test(report);
  const frontendReviewFailed = frontendReview && !frontendReviewPassed;
  const totalRows =
    1 +
    logs.length +
    steps.length +
    (hasPreparation ? 1 : 0) +
    (hasUnplannedEdits ? 1 : 0) +
    (busy ? 1 : 0) +
    (busy ? 0 : 1);
  const isLast = (index: number) => index === totalRows - 1;
  let rowIndex = 0;
  return (
    <div>
      <div className="mb-3 flex items-center gap-1.5">
        <ClipboardList className="h-3.5 w-3.5 text-primary/70" />
        <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Execution plan
        </span>
        <span className="ml-auto shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground/70">
          {done}/{steps.length}
        </span>
      </div>
      <ol className="relative">
        {(() => {
          const last = isLast(rowIndex++);
          return (
            <li className="relative flex min-h-9 gap-2.5 pb-2.5 last:pb-0">
              {!last && <TimelineConnector complete />}
              <span className="relative z-10 flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <MessageSquareText className="h-2.5 w-2.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[11px] font-semibold leading-[17px] text-foreground">
                    Original request
                  </span>
                  <time className="text-[10px] tabular-nums text-muted-foreground/65">
                    {formatRequestTime(requestedAt)}
                  </time>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-muted/35 px-3 py-2 text-[11px] leading-relaxed text-foreground/80">
                  {request.trim() || "Original request text is unavailable."}
                </p>
                {images.length > 0 && (
                  <div className="mt-2 flex max-w-md flex-wrap items-start gap-2">
                    {images.map((src, index) => (
                      <img
                        key={`request-image:${index}`}
                        src={src}
                        alt={`Request screenshot ${index + 1}`}
                        className="block h-auto max-h-52 w-auto max-w-full rounded-lg border border-border/70 bg-muted/30 object-contain"
                      />
                    ))}
                  </div>
                )}
              </div>
            </li>
          );
        })()}
        {logs.map((item) => {
          const last = isLast(rowIndex++);
          const Icon = workflowLogIcon(item.logTopic);
          const warning = item.logTopic === "llm.request" && /⚠/.test(item.text);
          return (
            <li key={item.id} className="relative flex min-h-9 gap-2.5 pb-2.5 last:pb-0">
              {!last && <TimelineConnector complete />}
              <span
                className={cn(
                  "relative z-10 flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full",
                  warning
                    ? "bg-destructive/12 text-destructive"
                    : "bg-primary/10 text-primary"
                )}
              >
                <Icon className="h-2.5 w-2.5" />
              </span>
              {item.logDetail ? (
                <LogDetailRow
                  item={item}
                  open={openSteps.includes(item.id)}
                  onToggle={() => onToggleStep(item.id)}
                />
              ) : (
                <span className="min-w-0 flex-1 break-words text-[11px] leading-[17px] text-muted-foreground">
                  {item.text}
                </span>
              )}
            </li>
          );
        })}
        {hasPreparation && (() => {
          const last = isLast(rowIndex++);
          const open = openSteps.includes("preparation");
          return (
            <li className="relative flex min-h-9 gap-2.5 pb-2.5 last:pb-0">
              {!last && <TimelineConnector complete />}
              <span className="relative z-10 flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Wrench className="h-2.5 w-2.5" />
              </span>
              <div className="min-w-0 flex-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onToggleStep("preparation")}
                  aria-expanded={open}
                  className="-mt-1 h-auto min-h-7 w-full justify-start px-0 py-0.5 text-[11px] hover:bg-transparent"
                >
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block font-semibold text-foreground">Preparation & planning</span>
                    <span className="block text-[10px] font-normal text-muted-foreground/70">
                      {unassignedActions.length} tools
                    </span>
                  </span>
                  {open ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </Button>
                <AnimatePresence initial={false}>
                  {open && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="pt-2">
                        <StepEvidence actions={unassignedActions} diffs={[]} />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </li>
          );
        })()}
        {steps.map((step) => {
          const last = isLast(rowIndex++);
          const stepActions = actions.filter((action) => action.stepId === step.id);
          const stepDiffs = diffs.filter((diff) => diff.stepId === step.id);
          const open = openSteps.includes(step.id);
          return (
            <li key={step.id} className="relative flex min-h-9 gap-2.5 pb-2.5 last:pb-0">
              {!last && (
                <TimelineConnector complete={step.status === "done"} />
              )}
              <PlanStepNode status={step.status} />
              <div className="min-w-0 flex-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onToggleStep(step.id)}
                  aria-expanded={open}
                  className="-mt-1 h-auto min-h-7 w-full min-w-0 justify-start whitespace-normal px-0 py-0.5 pr-1 text-left hover:bg-transparent"
                >
                  <span className="min-w-0 flex-1 overflow-hidden">
                    <span className="block break-words text-[11px] font-semibold text-foreground">
                      {step.title}
                    </span>
                    <span className="block text-[10px] font-normal text-muted-foreground/70">
                      {stepActions.length} tools · {stepDiffs.length} edits
                    </span>
                    {step.files.length > 0 && (
                      <span className="mt-0.5 block whitespace-normal break-all font-mono text-[10px] font-normal text-muted-foreground/55">
                        {step.files.join(", ")}
                      </span>
                    )}
                  </span>
                  {open ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                </Button>
                <AnimatePresence initial={false}>
                  {open && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="space-y-2 pt-2">
                        {(step.detail || step.verification || step.note) && (
                          <div className="grid gap-1.5 rounded-lg bg-muted/35 px-3 py-2 text-[11px]">
                            {step.detail && <DetailLine label="Purpose" value={step.detail} />}
                            {step.verification && <DetailLine label="Verification" value={step.verification} />}
                            {step.note && <DetailLine label="Outcome" value={step.note} />}
                          </div>
                        )}
                        <StepEvidence actions={stepActions} diffs={stepDiffs} />
                        {stepActions.length === 0 && stepDiffs.length === 0 && (
                          <span className="text-[11px] text-muted-foreground/60">
                            No tool calls or file edits were recorded for this step.
                          </span>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </li>
          );
        })}
        {hasUnplannedEdits && (() => {
          const last = isLast(rowIndex++);
          const open = openSteps.includes("unplanned-edits");
          return (
            <li className="relative flex min-h-9 gap-2.5 pb-2.5 last:pb-0">
              {!last && <TimelineConnector complete={false} />}
              <span className="relative z-10 flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <Wrench className="h-2.5 w-2.5" />
              </span>
              <div className="min-w-0 flex-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onToggleStep("unplanned-edits")}
                  aria-expanded={open}
                  className="-mt-1 h-auto min-h-7 w-full justify-start px-0 py-0.5 text-[11px] hover:bg-transparent"
                >
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block font-semibold text-destructive">Unplanned file edits</span>
                    <span className="block text-[10px] font-normal text-muted-foreground/70">
                      {unassignedDiffs.length} {unassignedDiffs.length === 1 ? "edit" : "edits"} outside a plan step
                    </span>
                  </span>
                  {open ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </Button>
                <AnimatePresence initial={false}>
                  {open && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="pt-2">
                        <StepEvidence actions={[]} diffs={unassignedDiffs} />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </li>
          );
        })()}
        {busy && (
          <li className="relative flex min-h-9 gap-2.5 pb-2.5 last:pb-0">
            <TimelineConnector complete={false} />
            <span className="relative z-10 flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full border-2 border-primary bg-card text-primary ring-4 ring-primary/15">
              <BrainCircuit className="h-2.5 w-2.5 animate-pulse" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-semibold leading-[17px] text-foreground">
                {thinking.trim() ? "Thinking" : "Working"}
              </span>
              <span className="text-shimmer block truncate text-[10px] text-muted-foreground">
                {thinking.trim() || status}
              </span>
            </span>
          </li>
        )}
        {!busy && (
          <ReportRow
            report={report}
            frontendReview={frontendReview}
            frontendReviewFailed={frontendReviewFailed}
            compact={compact}
          />
        )}
      </ol>
    </div>
  );
});

/**
 * The turn's closing row.
 *
 * Full width the report prints inline, where there is room for it. In the
 * preview sidebar (~230px) that same report is by far the tallest thing on
 * the timeline and pushes everything it summarises off-screen, so compact
 * keeps its opening line and moves the document itself behind "Show more".
 */
function ReportRow({
  report,
  frontendReview,
  frontendReviewFailed,
  compact,
}: {
  report: string;
  frontendReview: boolean;
  frontendReviewFailed: boolean;
  compact: boolean;
}) {
  const [open, setOpen] = useState(false);
  const body = report.trim();
  const title = frontendReview
    ? frontendReviewFailed
      ? "Review failed"
      : "Review passed"
    : "Report";

  return (
    <li className="relative flex min-h-9 gap-2.5 pb-2.5 last:pb-0">
      <span
        className={cn(
          "relative z-10 flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full text-white",
          frontendReviewFailed ? "bg-destructive" : "bg-success"
        )}
      >
        {frontendReviewFailed ? (
          <XCircle className="h-2.5 w-2.5" />
        ) : (
          <FileCheck2 className="h-2.5 w-2.5" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <span className="block text-[11px] font-semibold leading-[17px] text-foreground">
          {title}
        </span>
        {!body ? (
          <p className="mt-1 text-[11px] text-muted-foreground/65">
            No final report was recorded for this request.
          </p>
        ) : compact ? (
          <div className="mt-1 flex flex-col gap-1.5 rounded-lg bg-muted/35 px-2.5 py-2">
            <p className="line-clamp-3 text-[11px] leading-relaxed text-foreground/80">
              {reportSummary(body)}
            </p>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className={cn(
                "flex w-full items-center justify-center gap-1 rounded-md bg-primary/10 px-2 py-1",
                "text-[10px] font-semibold text-primary hover:bg-primary/20"
              )}
            >
              <Maximize2 className="h-3 w-3 shrink-0" />
              Show more
            </button>
          </div>
        ) : (
          <div className="chat-md mt-1 rounded-lg bg-muted/35 px-3 py-2 text-[11px] text-foreground/80">
            <Markdown remarkPlugins={[remarkGfm]}>{report}</Markdown>
          </div>
        )}
      </div>
      <AnimatePresence>
        {open && (
          <ReportModal title={title} report={report} onClose={() => setOpen(false)} />
        )}
      </AnimatePresence>
    </li>
  );
}

/**
 * The full report, over the whole window rather than the sidebar it was
 * opened from. Mounted on `document.body`: the card above it is a framer
 * `layout` element, and a transformed ancestor would anchor a fixed overlay
 * to the card instead of to the viewport.
 */
function ReportModal({
  title,
  report,
  onClose,
}: {
  title: string;
  report: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-6"
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ type: "spring", stiffness: 300, damping: 28 }}
        onClick={(event) => event.stopPropagation()}
        className="modal-surface island flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden"
      >
        <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <FileCheck2 className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the report"
            className="shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="chat-md min-h-0 flex-1 overflow-y-auto px-4 py-3 text-xs text-foreground/85">
          <Markdown remarkPlugins={[remarkGfm]}>{report}</Markdown>
        </div>
      </motion.div>
    </motion.div>,
    document.body
  );
}

/**
 * The report's opening prose as plain text. Markdown markers are stripped
 * rather than rendered: the preview is three clamped lines, and a heading or
 * a bullet glyph there reads as a broken document instead of a summary.
 */
function reportSummary(report: string): string {
  for (const raw of report.split("\n")) {
    const line = raw.trim();
    if (!line || /^([-*_])\1{2,}$/.test(line.replace(/\s/g, ""))) continue;
    const text = line
      .replace(/^#{1,6}\s*/, "")
      .replace(/^>\s*/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`~]/g, "")
      .trim();
    if (text) return text;
  }
  return report.trim();
}

function formatRequestTime(timestamp: number | null): string {
  if (timestamp === null) return "time unavailable";
  return new Date(timestamp).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-20 shrink-0 font-medium text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 break-words text-foreground/80">{value}</span>
    </div>
  );
}

function StepEvidence({
  actions,
  diffs,
}: {
  actions: AgentAction[];
  diffs: LiveDiff[];
}) {
  const [openEvidence, setOpenEvidence] = useState<string[]>([]);
  const entries = [
    ...actions.map((action) => ({ kind: "action" as const, seq: action.seq, action })),
    ...diffs.map((diff) => ({ kind: "diff" as const, seq: diff.seq, diff })),
  ].sort((left, right) => left.seq - right.seq);
  const toggle = (id: string) =>
    setOpenEvidence((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    );

  return (
    <ol className="relative">
      {entries.map((entry, index) => {
        const id = entry.kind === "action" ? entry.action.id : entry.diff.id;
        const open = openEvidence.includes(id);
        const last = index === entries.length - 1;
        return (
          <li key={`${entry.kind}:${id}`} className="relative flex gap-2.5 pb-2.5 last:pb-0">
            {!last && (
              <span
                aria-hidden
                className="absolute bottom-0 left-[6px] top-[15px] w-px bg-border"
              />
            )}
            {entry.kind === "action" ? (
              <ActionEvidence
                action={entry.action}
                open={open}
                onToggle={() => toggle(id)}
              />
            ) : (
              <DiffEvidence
                diff={entry.diff}
                open={open}
                onToggle={() => toggle(id)}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ActionEvidence({
  action,
  open,
  onToggle,
}: {
  action: AgentAction;
  open: boolean;
  onToggle: () => void;
}) {
  const StatusIcon =
    action.status === "running"
      ? Loader2
      : action.status === "done"
        ? Check
        : XCircle;
  return (
    <>
      <span
        className={cn(
          "relative z-10 mt-0.5 flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-full bg-card",
          action.status === "failed" ? "text-destructive" : "text-success"
        )}
      >
        <StatusIcon
          className={cn("h-3 w-3", action.status === "running" && "animate-spin text-primary")}
        />
      </span>
      <div className="min-w-0 flex-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onToggle}
          aria-expanded={open}
          className="-mt-1 h-auto min-h-6 w-full min-w-0 justify-start whitespace-normal px-0 py-0.5 text-left hover:bg-transparent"
        >
          <span className="min-w-0 flex-1 break-all font-mono text-[11px] font-normal text-muted-foreground">
            {action.label}
          </span>
          {action.durationMs !== undefined && action.durationMs >= SLOW_TOOL_MS && (
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/55">
              {formatDuration(action.durationMs)}
            </span>
          )}
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
        </Button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="space-y-2 pb-1 pt-1">
                <EvidenceSection
                  label="Requested"
                  value={action.detail ?? "No structured request details were recorded."}
                />
                <EvidenceSection
                  label={action.error ? "Error" : "Result"}
                  value={
                    action.error ??
                    action.result ??
                    action.output ??
                    (action.status === "running"
                      ? "Waiting for the tool result…"
                      : "Result was not captured for this earlier call. It will be restored from the persisted execution timeline when the task finishes.")
                  }
                  error={Boolean(action.error)}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}

function EvidenceSection({
  label,
  value,
  error = false,
}: {
  label: string;
  value: string;
  error?: boolean;
}) {
  return (
    <section className="min-w-0 rounded-lg bg-muted/25 px-2.5 py-2">
      <span className="block text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/55">
        {label}
      </span>
      <pre
        className={cn(
          "mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed",
          error ? "text-destructive" : "text-foreground/70"
        )}
      >
        {value}
      </pre>
    </section>
  );
}

function DiffEvidence({
  diff,
  open,
  onToggle,
}: {
  diff: LiveDiff;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <span className="relative z-10 mt-0.5 flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Wrench className="h-2.5 w-2.5" />
      </span>
      <div className="min-w-0 flex-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onToggle}
          aria-expanded={open}
          className="-mt-1 h-auto min-h-6 w-full min-w-0 justify-start whitespace-normal px-0 py-0.5 text-left hover:bg-transparent"
        >
          <span className="min-w-0 flex-1 break-all font-mono text-[11px] font-normal text-muted-foreground">
            Diff · {diff.path}
          </span>
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
        </Button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden pb-1 pt-1"
            >
              <div className="max-h-72 min-h-24 overflow-auto rounded-lg bg-muted/25">
                <UnifiedDiffView before={diff.before} after={diff.after} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}

function TimelineConnector({ complete }: { complete: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute bottom-0 left-[8px] top-[18px] w-px",
        complete ? "bg-success/40" : "bg-border"
      )}
    />
  );
}

function workflowLogIcon(topic: string | undefined) {
  if (topic === "knowledge.retrieved") return Network;
  if (topic === "session.recalled") return History;
  if (topic === "working-memory.reused") return History;
  if (topic === "scope.locked" || topic === "scope.escaped") return FolderLock;
  if (topic === "llm.request") return Send;
  if (topic === "wiki.recalled" || topic === "wiki.updated") return BookOpen;
  return Radar;
}

/**
 * A log line with a body behind it — the full context a model request
 * carried. Collapsed it is one line like every other log; expanded it
 * shows the body verbatim in a scrollable monospace block, so what the
 * model was actually given can be read rather than inferred.
 */
function LogDetailRow({
  item,
  open,
  onToggle,
}: {
  item: ChatItemVm;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="min-w-0 flex-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onToggle}
        aria-expanded={open}
        className="-mt-1 h-auto min-h-7 w-full justify-start px-0 py-0.5 text-[11px] hover:bg-transparent"
      >
        <span className="min-w-0 flex-1 whitespace-normal break-words text-left font-normal leading-[17px] text-muted-foreground">
          {item.text}
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
      </Button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/35 px-3 py-2 font-mono text-[10.5px] leading-relaxed text-foreground/80">
              {item.logDetail}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * One node on the plan rail. Every state is the same 17px circle so the rail
 * stays straight — only the fill, the border and the glyph change.
 */
function PlanStepNode({ status }: { status: PlanStep["status"] }) {
  const base =
    "relative z-10 mt-px flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full";

  if (status === "done") {
    return (
      <span className={cn(base, "bg-success text-white")}>
        <Check className="h-2.5 w-2.5" strokeWidth={3} />
      </span>
    );
  }
  if (status === "in-progress") {
    return (
      <span
        className={cn(
          base,
          "border-2 border-primary bg-card text-primary",
          "ring-4 ring-primary/15"
        )}
      >
        <Loader2 className="h-2.5 w-2.5 animate-spin" strokeWidth={3} />
      </span>
    );
  }
  if (status === "failed" || status === "cancelled") {
    return (
      <span className={cn(base, "bg-destructive text-white")}>
        <X className="h-2.5 w-2.5" strokeWidth={3} />
      </span>
    );
  }
  return (
    <span
      className={cn(base, "border border-muted-foreground/35 bg-card")}
      aria-hidden
    />
  );
}

/** Tool calls owned by one execution-plan step, most recent last. */
const ActionRows = memo(function ActionRows({
  actions,
}: {
  actions: AgentAction[];
}) {
  return (
    <div className="space-y-1">
      <AnimatePresence initial={false}>
        {actions.map((action) => (
          <motion.div
            key={action.id}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            // A row per tool call, each on its own surface: the plan above is
            // one connected flow, so the feed under it has to read as discrete
            // events rather than as more steps in that flow.
            className={cn(
              "flex items-start gap-2 rounded-lg border border-border/70 bg-muted/15 px-3 py-2",
              "text-[11px] text-muted-foreground"
            )}
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
              {action.output && (
                <span className="mt-1 block max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 px-2 py-1.5 font-mono text-[10px] text-foreground/70">
                  {action.output}
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
