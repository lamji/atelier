import type { ValidationResult } from "@atelier/protocol";

/** How the run that produced this report ended. */
export type NoteRunStatus = "completed" | "cancelled" | "error";

/** The prose sections, written by the narrative pass (or absent). */
export interface NoteNarrative {
  issue: string;
  fix: string;
  flow: string;
}

export interface NoteReportInput {
  taskId: string;
  status: NoteRunStatus;
  /** The user's request for this turn, verbatim. */
  request: string;
  intentKind: string;
  intentSummary: string;
  planGoal: string;
  steps: Array<{
    title: string;
    detail?: string;
    files: string[];
    status?: string;
  }>;
  changedFiles: string[];
  validation: ValidationResult[];
  reviewVerdict: "pass" | "fail" | null;
  durationMs: number;
  /** Epoch millis stamped into the section heading. */
  at: number;
  /** Issue/fix/flow prose; null when the narrative pass produced nothing. */
  narrative: NoteNarrative | null;
  /** The agent's own closing answer, the fallback when narrative is null. */
  assistantText: string;
  /** Set on an errored run. */
  errorMessage?: string;
}

/** Opens every appended entry; also how earlier entries are found again. */
const REPORT_HEADING = "## Implementation report — ";
const REPORT_HEADING_RE = /^## Implementation report — /m;

/** The note as the user wrote it, with entries from earlier runs removed. */
export function stripReports(content: string): string {
  const match = REPORT_HEADING_RE.exec(content);
  if (!match) return content;
  // The separator rule introduces the entry, so it goes with it.
  return content.slice(0, match.index).replace(/\n---\s*$/, "");
}

/** Caps so one run cannot turn a note into a transcript. */
const MAX_REQUEST_CHARS = 1_200;
const MAX_ASSISTANT_CHARS = 1_600;
const MAX_FILES = 40;
const MAX_STEPS = 20;

/**
 * The block appended to a note when its task finishes. It opens with a rule
 * and its own `##` heading so it reads as one more entry under whatever the
 * user already wrote — nothing above it is ever rewritten, and a note driven
 * three times carries three of these in order.
 */
export function renderNoteReport(input: NoteReportInput): string {
  const lines: string[] = [
    "",
    "---",
    "",
    `${REPORT_HEADING}${formatStamp(input.at)}`,
    "",
    metaLine(input),
    "",
  ];

  push(
    lines,
    "### Request",
    clip(input.request, MAX_REQUEST_CHARS) ||
      "_This note was run as-is; no extra instructions were typed._"
  );

  if (input.narrative) {
    push(lines, "### Issue", input.narrative.issue);
    push(lines, "### Fix", input.narrative.fix);
  } else {
    // No narrative pass: the agent's closing answer is the only prose that
    // describes the work, and dropping it would leave the entry factual but
    // unreadable. Say where it came from rather than passing it off as a
    // written-up issue/fix.
    push(
      lines,
      "### Summary (from the agent's own answer)",
      clip(input.assistantText, MAX_ASSISTANT_CHARS)
    );
  }

  push(lines, "### What was implemented", stepsBlock(input));
  push(lines, "### Files touched", filesBlock(input.changedFiles));
  if (input.narrative) push(lines, "### Flow", input.narrative.flow);
  push(lines, "### Validation", validationBlock(input.validation));
  push(lines, "### Review", reviewBlock(input.reviewVerdict));

  if (input.status !== "completed") {
    push(
      lines,
      "### Interrupted",
      input.status === "cancelled"
        ? "The user stopped this run before it finished — the work above is " +
            "partial, and the note stays in progress."
        : `The run ended in an error, so the work above is partial: ${clip(
            input.errorMessage ?? "unknown failure",
            400
          )}`
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** Task id, outcome, duration — the one-line provenance of the entry. */
function metaLine(input: NoteReportInput): string {
  const parts = [
    `**Status:** ${input.status === "completed" ? "review" : "in progress"}`,
    `**Kind:** ${input.intentKind}`,
    `**Task:** \`${input.taskId}\``,
    `**Took:** ${formatDuration(input.durationMs)}`,
  ];
  const goal = input.planGoal || input.intentSummary;
  return goal ? `${parts.join(" · ")}\n\n**Goal:** ${goal}` : parts.join(" · ");
}

/**
 * The plan as it actually ran. Only steps the tracker marked done are
 * claimed as implemented; anything still open is listed separately, because
 * an unfinished step read as a finished one is the entry's worst failure.
 */
function stepsBlock(input: NoteReportInput): string {
  const steps = input.steps.slice(0, MAX_STEPS);
  if (steps.length === 0) return "_No plan steps were recorded for this run._";
  const done = steps.filter((s) => !s.status || s.status === "done");
  const open = steps.filter((s) => s.status && s.status !== "done");
  const out: string[] = [];
  for (const step of done) out.push(stepLine(step));
  if (open.length > 0) {
    out.push("", "Not completed in this run:");
    for (const step of open) out.push(stepLine(step));
  }
  return out.join("\n");
}

function stepLine(step: NoteReportInput["steps"][number]): string {
  const detail = step.detail ? ` — ${step.detail}` : "";
  const files =
    step.files.length > 0
      ? `\n  - ${step.files.map((f) => `\`${f}\``).join(", ")}`
      : "";
  return `- **${step.title}**${detail}${files}`;
}

function filesBlock(changedFiles: string[]): string {
  if (changedFiles.length === 0) return "_No files were changed._";
  const shown = changedFiles.slice(0, MAX_FILES);
  const more =
    changedFiles.length > shown.length
      ? `\n- _…and ${changedFiles.length - shown.length} more_`
      : "";
  return shown.map((f) => `- \`${f}\``).join("\n") + more;
}

function validationBlock(validation: ValidationResult[]): string {
  if (validation.length === 0) return "_No validators ran for this change._";
  return validation
    .map((result) => {
      if (result.ok) return `- ${result.kind}: passed`;
      const count = result.findings.length;
      return `- ${result.kind}: **failing**${
        count > 0 ? ` — ${count} finding(s)` : ""
      }`;
    })
    .join("\n");
}

function reviewBlock(verdict: "pass" | "fail" | null): string {
  if (verdict === null) return "_The independent review did not run._";
  return verdict === "pass"
    ? "Independent review **passed**."
    : "Independent review **failed** — see the chat transcript for the " +
        "findings that were left unresolved.";
}

/** Appends a heading and its body when the body has content. */
function push(lines: string[], heading: string, body: string): void {
  const text = body.trim();
  if (!text) return;
  lines.push(heading, "", text, "");
}

/** `2026-07-29 14:03` in the agent host's local time. */
function formatStamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
