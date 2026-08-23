/**
 * `/context_debug` — the structured bug report.
 *
 * A pinned feature tells the agent WHERE the code is; it says nothing about
 * what went wrong. Free-text bug reports arrive missing exactly the two
 * things a debug turn cannot start without: how to reproduce the defect and
 * what should have happened instead. So the command answers with a filled-in
 * markdown skeleton rather than a question, the user edits it, and sends it
 * back under the same command.
 *
 * The round trip is plain text on purpose: the report travels as the prompt
 * body, so a surface that can open a markdown editor on this template gets a
 * modal, and a surface that cannot still gets a working command. Screenshots
 * ride the normal attachment path — nothing here needs to carry bytes.
 */
export const FEATURE_CONTEXT_DEBUG_COMMAND_NAME = "context_debug";
export const FEATURE_CONTEXT_DEBUG_COMMAND_ID =
  "project:command:" + FEATURE_CONTEXT_DEBUG_COMMAND_NAME;

/** The four sections of a report, as read back off a filled template. */
export interface DebugReport {
  /** Required: how to reproduce, in the user's own numbered steps. */
  steps: string;
  /** Required: what should have happened at the last step. */
  expected: string;
  /** Optional: what happened instead, when it is not obvious. */
  actual: string;
  /** Optional: anything else — error text, environment, a hunch. */
  notes: string;
}

const STEPS_HEADING = "Steps to replicate";
const EXPECTED_HEADING = "Expected result";
const ACTUAL_HEADING = "Actual result";
const NOTES_HEADING = "Notes";

/**
 * What the editor opens with. Every required section is present and empty,
 * so the user fills blanks instead of remembering a format, and the reader
 * below can find each one again by its heading.
 */
export const DEBUG_REPORT_TEMPLATE =
  "# Bug report\n" +
  "\n" +
  "## " + STEPS_HEADING + "\n" +
  "1. \n" +
  "2. \n" +
  "3. \n" +
  "\n" +
  "## " + EXPECTED_HEADING + "\n" +
  "\n" +
  "\n" +
  "## " + ACTUAL_HEADING + "\n" +
  "\n" +
  "\n" +
  "## " + NOTES_HEADING + "\n" +
  "\n";

/** Shown above the template the first time, so the round trip is obvious. */
export const DEBUG_REPORT_PROMPT =
  "Fill this in and send it back with /context_debug. Steps to replicate " +
  "and Expected result are required; Actual result and Notes are optional. " +
  "Attach screenshots to the same message and highlight the exact area at " +
  "fault; I will gather that element's end-to-end code context.";

/**
 * Returns undefined when the prompt is not /context_debug. An empty string
 * means the command was invoked bare — hand back the blank template. Both
 * the underscore and the hyphen spelling are accepted, matching
 * /context_update.
 */
export function parseFeatureContextDebugCommand(
  prompt: string
): string | undefined {
  const match = /^\/context[_-]debug(?:\s+([\s\S]*))?$/i.exec(prompt.trim());
  if (!match) return undefined;
  // Unlike the feature-name commands this body is a document: keep its
  // line breaks, since the headings below are what give it structure.
  return (match[1] ?? "").trim();
}

/**
 * Reads a filled template back into its sections. Returns null when the two
 * required sections are still blank — an untouched skeleton and a report
 * that only says "it's broken" both land here, and both need the form back
 * rather than a debug turn started on nothing.
 */
export function parseDebugReport(body: string): DebugReport | null {
  const sections = splitSections(body);
  const steps = section(sections, STEPS_HEADING);
  const expected = section(sections, EXPECTED_HEADING);
  // No headings at all: the user typed prose after the command. Treat the
  // whole body as the steps rather than rejecting a real report on format.
  if (sections.size === 0 && meaningful(body)) {
    return { steps: body.trim(), expected: "", actual: "", notes: "" };
  }
  if (!meaningful(steps) || !meaningful(expected)) return null;
  return {
    steps: steps.trim(),
    expected: expected.trim(),
    actual: section(sections, ACTUAL_HEADING).trim(),
    notes: section(sections, NOTES_HEADING).trim(),
  };
}

/**
 * The report as a debug task the pipeline can run: the user's own words
 * first, then the evidence rules the debugging skill applies anyway. Written
 * as a prompt rather than pasted markdown so the model reads it as the task
 * and not as a document someone attached.
 */
export function renderDebugTask(report: DebugReport, images: number): string {
  const lines = [
    "Debug this reported defect.",
    "",
    "STEPS TO REPLICATE:",
    report.steps,
    "",
    "EXPECTED RESULT:",
    report.expected || "(not stated — infer it from the steps)",
  ];
  if (report.actual) lines.push("", "ACTUAL RESULT:", report.actual);
  if (report.notes) lines.push("", "NOTES:", report.notes);
  if (images > 0) {
    lines.push(
      "",
      images +
        " screenshot(s) are attached to this message. Read them as evidence " +
        "of the observed behaviour, never as proof of the current code.",
      "Inspect every screenshot before searching. If one contains a highlight, " +
        "box, circle, or arrow, treat the marked UI as the defect scope. State " +
        "in one line what the annotation points at, then extract grounded " +
        "anchors from that region: visible text, control type, screen or route, " +
        "state, and error text.",
      "Use those anchors to gather all relevant live code context for the " +
        "highlighted element before editing: its owning screen/component and " +
        "file, render path, trigger and event handler, state/view-model, " +
        "service/API/data path, callers/importers, and focused tests. Trace " +
        "that chain end to end to the terminal effect. Use the surrounding " +
        "screenshot only as supporting context; do not switch to an unmarked " +
        "defect."
    );
  }
  lines.push(
    "",
    "Reproduce the divergence in the code before editing: find the trigger " +
      "named in the steps, read its live owner, and trace the handler, data " +
      "and render path to the point where the result stops matching the " +
      "expectation. Fix that confirmed cause only, then verify it."
  );
  return lines.join("\n");
}

/** `## Heading` → body, for the headings this template defines. */
function splitSections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current) out.set(current, buffer.join("\n"));
    buffer = [];
  };
  for (const line of body.split(/\r?\n/)) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = heading[1]!.toLowerCase().replace(/[^a-z]+/g, " ").trim();
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  return out;
}

function section(sections: Map<string, string>, heading: string): string {
  const key = heading.toLowerCase();
  for (const [name, value] of sections) {
    if (name === key || name.startsWith(key)) return value;
  }
  return "";
}

/**
 * True when a section carries content rather than the skeleton. The empty
 * numbered list the template ships with is the common case: `1.` on its own
 * line is a placeholder, not a step.
 */
function meaningful(value: string): boolean {
  const stripped = value
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "").trim())
    .join("")
    .replace(/[\s_-]+/g, "");
  return stripped.length > 0;
}
