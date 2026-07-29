import type { Logger } from "pino";
import type { MarkdownStatus, ReasoningEffort } from "@atelier/protocol";
import {
  stripFrontmatter,
  typedInstructionsOf,
  upsertFrontmatterStatus,
} from "@atelier/shared";
import { runOneShot } from "../providers/one-shot.js";
import type { FileService } from "../workspace/file-service.js";
import {
  renderNoteReport,
  stripReports,
  type NoteNarrative,
  type NoteReportInput,
} from "./note-report.js";

/** Notes live in the app's own cache folder; nothing else is writable here. */
const NOTE_DIR = ".atelier/";

/** Small, fast model for the narrative pass — same tier as the plan stages. */
const NARRATIVE_MODEL = "claude-haiku-4-5";

const NARRATIVE_SYSTEM =
  "You are writing the implementation record that goes into a project note " +
  "after a coding task finished. You are given everything the run actually " +
  "produced. Write in past tense about what THIS run did, and ground every " +
  "sentence in the facts you were given — never invent a file, a symbol, a " +
  "step or a behavior that does not appear in them. When the facts do not " +
  "support a section, say so in one short sentence instead of filling it " +
  "out. Reply with ONLY valid JSON, no prose.";

/** Caps on what rides into the narrative prompt. */
const MAX_PROMPT_NOTE = 4_000;
const MAX_PROMPT_REQUEST = 1_500;
const MAX_PROMPT_ANSWER = 3_000;
const MAX_PROMPT_FILES = 40;

export interface NoteJournalDeps {
  files: FileService;
  workspaceRoot: string;
  log: Logger;
}

/** Model/effort of the run, so the narrative follows the user's provider. */
export interface NoteRunModel {
  model?: string;
  effort?: ReasoningEffort;
}

/**
 * Keeps a markdown note in step with the task it drove.
 *
 * A note picked in the composer is a unit of work, so its `status:` follows
 * the run: `in-progress` the moment the task starts, `review` when it
 * finishes. On the way out the run's record is APPENDED as a dated section —
 * the user's own content above it is never touched, so a note accumulates
 * its history instead of being overwritten by the last thing that ran.
 *
 * Every method is best effort. A note is a side record of the work, so a
 * read/write failure here is logged and swallowed: it must never be the
 * reason a task reports failure.
 */
export class NoteJournal {
  /** In-flight write chain per note — see enqueue(). */
  private queues = new Map<string, Promise<void>>();

  constructor(private deps: NoteJournalDeps) {}

  /** True for a path this journal is allowed to touch. */
  private writable(notePath: string): boolean {
    const normalized = notePath.replace(/\\/g, "/");
    if (normalized.split("/").includes("..")) return false;
    return normalized.startsWith(NOTE_DIR) && /\.md$/i.test(normalized);
  }

  /**
   * Serializes every write to one note. The status flip fires as the task
   * starts and the report lands when it ends, but both are read-modify-write
   * on the same file: a short task could otherwise have the flip read the
   * note before the report was appended and write the report away again.
   */
  private enqueue(notePath: string, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(notePath) ?? Promise.resolve();
    const next = previous.then(work, work).catch(() => undefined);
    this.queues.set(notePath, next);
    void next.then(() => {
      if (this.queues.get(notePath) === next) this.queues.delete(notePath);
    });
    return next;
  }

  /** Flips the note to `in-progress` as its task starts. */
  async markInProgress(notePath: string): Promise<void> {
    await this.setStatus(notePath, "in-progress");
  }

  /**
   * The note's display title — its first heading, or its filename. Read
   * through the catalog's own parse so the name in the history list is the
   * name the Markdown panel shows for the same file.
   */
  async title(notePath: string): Promise<string | null> {
    if (!this.writable(notePath)) return null;
    const file = await this.deps.files.markdownFile(notePath);
    return file?.title.trim() || null;
  }

  /**
   * Writes the run's record into the note: the report section appended at
   * the end, and the status moved to `review` — but only on a run that
   * finished. A cancelled or crashed run leaves the note `in-progress`,
   * because its report says the work is partial and a note in review reads
   * as work waiting to be checked.
   */
  async writeReport(
    notePath: string,
    input: Omit<NoteReportInput, "narrative">,
    run: NoteRunModel = {}
  ): Promise<void> {
    if (!this.writable(notePath)) return;
    let content: string;
    try {
      ({ content } = await this.deps.files.readFile(notePath));
    } catch (error) {
      this.deps.log.warn(
        { err: error, notePath },
        "could not read the note to append its task report"
      );
      return;
    }

    // The prompt for a note-driven run OPENS with the note's own text. Only
    // what the user typed on top of it belongs in the record — writing the
    // whole prompt back would copy the note into itself once per run.
    const facts = {
      ...input,
      request: typedInstructionsOf(input.request, content),
    };
    const narrative =
      facts.status === "completed"
        ? await this.narrate(facts, noteBrief(content), run)
        : null;
    const report = renderNoteReport({ ...facts, narrative });

    // Only the read-modify-write is serialized; the model call above holds
    // no lock, so a second task on the same note is not stuck behind it.
    await this.enqueue(notePath, async () => {
      try {
        // Re-read: the narrative pass took a model call, and the note may
        // have been edited meanwhile. Appending to the stale copy would drop
        // whatever the user just wrote.
        const { content: latest } = await this.deps.files.readFile(notePath);
        const withReport = `${latest.replace(/\s*$/, "")}\n${report}`;
        const next =
          facts.status === "completed"
            ? upsertFrontmatterStatus(withReport, "review")
            : withReport;
        await this.deps.files.writeFile(notePath, next);
      } catch (error) {
        this.deps.log.warn(
          { err: error, notePath },
          "could not append the task report to its note"
        );
      }
    });
  }

  private async setStatus(
    notePath: string,
    status: MarkdownStatus
  ): Promise<void> {
    if (!this.writable(notePath)) return;
    await this.enqueue(notePath, async () => {
      try {
        const { content } = await this.deps.files.readFile(notePath);
        await this.deps.files.writeFile(
          notePath,
          upsertFrontmatterStatus(content, status)
        );
      } catch (error) {
        this.deps.log.warn(
          { err: error, notePath, status },
          "could not update the note's status"
        );
      }
    });
  }

  /**
   * The issue/fix/flow prose. One tool-less call on the small model, and
   * only for a note-driven run — the cost rides with the feature rather
   * than with every task. A failed or unparsable call is not an error: the
   * report falls back to the agent's own closing answer.
   */
  private async narrate(
    input: Omit<NoteReportInput, "narrative">,
    noteBody: string,
    run: NoteRunModel
  ): Promise<NoteNarrative | null> {
    try {
      const raw = await runOneShot({
        model: run.model,
        claudeFallback: NARRATIVE_MODEL,
        effort: run.effort,
        cwd: this.deps.workspaceRoot,
        json: true,
        system: NARRATIVE_SYSTEM,
        prompt: narrativePrompt(input, noteBody),
      });
      return parseNarrative(raw);
    } catch (error) {
      this.deps.log.warn(
        { err: error },
        "note narrative call failed; falling back to the agent's answer"
      );
      return null;
    }
  }
}

/**
 * The note as briefing material for the narrative pass: what the user
 * actually wrote, without the frontmatter or the entries earlier runs
 * appended. Those entries are this function's own past output, and feeding
 * them back is how a report starts describing the previous report.
 */
function noteBrief(content: string): string {
  return clip(stripReports(stripFrontmatter(content)), MAX_PROMPT_NOTE);
}

function narrativePrompt(
  input: Omit<NoteReportInput, "narrative">,
  noteBody: string
): string {
  const steps = input.steps
    .filter((step) => !step.status || step.status === "done")
    .map(
      (step) =>
        `- ${step.title}${step.detail ? `: ${step.detail}` : ""}` +
        (step.files.length > 0 ? ` [${step.files.join(", ")}]` : "")
    );
  const facts = [
    noteBody ? `The note this task was run from:\n${noteBody}` : "",
    input.request
      ? `What the user asked on top of the note: ` +
        clip(input.request, MAX_PROMPT_REQUEST)
      : "The note was run as-is; the user typed no extra instructions.",
    `Intent: ${input.intentKind} — ${input.intentSummary}`,
    input.planGoal ? `Goal: ${input.planGoal}` : "",
    steps.length > 0 ? `Steps completed:\n${steps.join("\n")}` : "",
    input.changedFiles.length > 0
      ? `Files changed:\n${input.changedFiles
          .slice(0, MAX_PROMPT_FILES)
          .map((f) => `- ${f}`)
          .join("\n")}`
      : "No files were changed.",
    input.validation.length > 0
      ? `Validation: ${input.validation
          .map((v) => `${v.kind} ${v.ok ? "passed" : "failed"}`)
          .join(", ")}`
      : "",
    input.reviewVerdict ? `Independent review: ${input.reviewVerdict}` : "",
    `The agent's own closing answer:\n${clip(
      input.assistantText,
      MAX_PROMPT_ANSWER
    )}`,
  ].filter(Boolean);

  return (
    `${facts.join("\n\n")}\n\n` +
    'JSON shape: {"issue":"...","fix":"...","flow":"..."}\n' +
    "issue: what was wrong or missing that made this request necessary, in " +
    "1-3 sentences.\n" +
    "fix: what was actually changed to address it, naming the real files " +
    "above and what each one now does, in 2-5 sentences.\n" +
    "flow: how the feature runs end to end after this change — the path an " +
    "action takes through the named files, in order, in 2-6 sentences.\n" +
    "Plain prose in each field; no markdown headings and no bullet lists."
  );
}

function parseNarrative(raw: string): NoteNarrative | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const value = parsed as Partial<NoteNarrative> | null;
  if (!value || typeof value !== "object") return null;
  const issue = text(value.issue);
  const fix = text(value.fix);
  const flow = text(value.flow);
  // A response with no usable field at all is a failed call, not an empty
  // report: fall back to the agent's answer rather than three blank headings.
  if (!issue && !fix && !flow) return null;
  return { issue, fix, flow };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
