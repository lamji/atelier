import type { TaskOptions } from "./orchestrator.js";

/**
 * The agent flow, from scratch (2026-08-31): ONE model loop per turn.
 *
 * The prompt, the conversation so far, the rules, every tool. No intent
 * classifier, scope lock, retrieval stage, plan stage, review, validation,
 * completion gate, nudge or continuation harness. The staged pipeline
 * refused the model's tool calls 58 times in one afternoon and hid its
 * reports; the user asked for it to be gone. It remains in the source
 * tree only; agent turns never enter it.
 */
export function isDirectMode(_opts: TaskOptions): boolean {
  return true;
}

/**
 * The tool surface of a direct turn: read, search, edit, git, terminal.
 *
 * Everything backed by the knowledge engine is withheld —
 * retrieve_knowledge, query_knowledge_graph, search_symbols,
 * impact_of_edit, analyze_impact — along with the pipeline's own
 * update_plan_step and save_lesson, which have nothing to write to here.
 * Withholding them is what makes "no retrieval" true rather than merely
 * requested: a rule in the prompt is advice, an absent tool is a fact.
 */
export const DIRECT_TOOLS = [
  "read_file",
  "read_many_files",
  "write_file",
  "replace_code",
  "replace_many",
  "search_workspace",
  "search_text",
  "list_dir",
  "git",
  "preview_review",
  "preview_console",
  "preview_test",
  "run_terminal",
];

/**
 * The rules every turn carries. Short on purpose: the environment the model
 * is in, how to use the memory it is given, and the three boundaries the
 * remaining hooks actually enforce (git flow, approval modals, workspace).
 * Nothing here describes a refusal, because nothing refuses.
 */
export const DIRECT_RULES =
  "ATELIER: you are the coding agent inside the user's editor, running " +
  "unattended — nobody answers you mid-turn. Do the work the latest message " +
  "asks for: read what you need, search, edit with replace_code / " +
  "replace_many (write_file for new files or true rewrites), run commands, " +
  "verify, then report once as concise markdown bullets — what changed, " +
  "where, how you checked. Never end a turn by asking whether to proceed or " +
  "by offering to implement; where something is ambiguous, pick the " +
  "reasonable default, state it in one line, and build it.\n" +
  "WORK: for a change you could describe in one sentence, do it directly. " +
  "For anything touching several files or an unfamiliar area, look first, " +
  "then state the plan in two or three lines, then implement it. Prefer " +
  "the Agent tool with the `investigator` subagent for broad " +
  "investigations, so hundreds of file reads do not fill this window, and " +
  "the `reviewer` subagent before reporting a non-trivial change as done. " +
  "Run several independent tool calls in ONE message.\n" +
  "SEARCH: work like a CLI: list directories, search literal text, read " +
  "the matching source, and follow its imports and callers. Use search_text " +
  "or search_workspace. Copy search terms from the user's request, supplied " +
  "context, directory entries, or actual tool results. Never invent likely " +
  "identifiers, paths, labels, or phrases to search for. If no concrete " +
  "term is available, list_dir and read the relevant files first. Start " +
  "with literal search; build regex alternatives only from observed terms. " +
  "An empty match is not evidence that a feature does not exist.\n" +
  "VERIFY WITH EVIDENCE: after a change, run the narrowest check that " +
  "proves it — the failing test, a typecheck, a build, a curl, the preview " +
  "tools — and put the command and its result in the report. A claim " +
  "without evidence is not done; a check that fails means keep working.\n" +
  "MEMORY: the CONVERSATION SO FAR block, when present, is what " +
  "was said and done earlier in this chat — a terse reply refers to the " +
  "closing part of your previous answer. PREVIOUSLY GATHERED CONTEXT is " +
  "what earlier turns already read; reuse it rather than re-reading " +
  "unchanged files.\n" +
  "BOUNDARY: workspace changes stay inside the active scope (the open " +
  "project). Never commit, push, or open a PR — the user does that. " +
  "Database and package commands use Atelier's approval modal. Installed " +
  "skills are runtime instructions, not project files: read their SKILL.md " +
  "and referenced resources from their registered external paths. A path " +
  "the user explicitly named outside the workspace is an authorized " +
  "read-only reference: read it directly.\n";

/** Hard caps for the locally assembled context (the user prompt is separate). */
export const LIGHT_LAYOUT_CHARS = 4_000;
export const LIGHT_USER_RULE_CHARS = 6_000;
/**
 * The carried conversation: the previous answer whole, the exchange before
 * it, what those turns did. It was 900 chars — two turns cut to 360 chars
 * each, head only — and the recommendation at the end of the previous
 * answer, the thing every terse follow-up points at, was the part cut.
 * ~14k chars is ~3.5k tokens, on turns that read 70k+ from cache: the
 * cheapest way to make the next turn not re-derive the last one.
 */
export const LIGHT_APPEND_CHARS = 60_000;
export const LIGHT_VIBE_CHARS = 2_000;
export const LIGHT_CONTEXT_MAX_CHARS = 80_000;

/** Local, deterministic compression: no model request is spent summarizing. */
export function clipLightContext(text: string, maxChars: number): string {
  const compact = text.replace(/\n{3,}/g, "\n\n").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/** Hard ceiling for a fresh automated continuation's execution state. */
export const EXECUTION_CHECKPOINT_MAX_CHARS = 6_500;

export interface ExecutionCheckpointInput {
  request: string;
  outstanding: string;
  goal?: string;
  steps: Array<{
    title: string;
    status?: string;
    files?: string[];
  }>;
  changedFiles: string[];
}

/**
 * Replaces an ever-growing native provider transcript between automated
 * continuation rounds. The carried execute context still supplies the exact
 * retrieved evidence; this checkpoint adds only the live state needed to
 * finish from it, without paying again for every earlier tool call.
 */
export function renderExecutionCheckpoint(
  input: ExecutionCheckpointInput
): string {
  const steps = input.steps
    .map((step, index) => {
      const files = step.files?.length
        ? ` — ${clipLightContext(step.files.join(", "), 240)}`
        : "";
      return `${index + 1}. [${step.status ?? "pending"}] ${clipLightContext(
        step.title,
        220
      )}${files}`;
    })
    .join("\n");
  const changed = input.changedFiles.length
    ? clipLightContext(input.changedFiles.join(", "), 600)
    : "none yet";
  const checkpoint = [
    "EXECUTION CHECKPOINT (fresh bounded continuation; do not reconstruct the earlier transcript)",
    `OUTSTANDING WORK:\n${clipLightContext(input.outstanding, 1_600)}`,
    `LATEST REQUEST:\n${clipLightContext(input.request, 1_200)}`,
    input.goal?.trim()
      ? `PLAN GOAL:\n${clipLightContext(input.goal, 500)}`
      : "",
    `LIVE PLAN:\n${steps || "No tracked plan."}`,
    `CHANGED FILES:\n${changed}`,
    "Continue from this checkpoint and the carried evidence. Do not repeat broad investigation. Inspect only the exact current source needed to finish or verify the open work.",
  ]
    .filter(Boolean)
    .join("\n\n");
  return clipLightContext(checkpoint, EXECUTION_CHECKPOINT_MAX_CHARS);
}

/** How many prior turns ride along in LIGHT mode. */
const MAX_PRIOR_TURNS = 2;

/** A prior turn is quoted this far and no further. */
const MAX_TURN_CHARS = 360;

/**
 * The conversation so far, verbatim.
 *
 * A direct turn recalls nothing from session memory, but a chat that
 * forgets the message before it is broken rather than plain: the SDK
 * transcript does not span Atelier tasks, so without this a follow-up
 * ("now make it blue") would arrive with no subject. This is the ordinary
 * chat transcript — no summarization, no embeddings, no retrieval.
 */
export function renderPriorTurns(
  turns: Array<{ role: "user" | "assistant"; text: string }>
): string {
  const recent = turns.slice(-MAX_PRIOR_TURNS).filter((turn) => turn.text.trim());
  if (recent.length === 0) return "";
  const lines = recent.map(
    (turn) =>
      `${turn.role === "user" ? "User" : "Assistant"}: ` +
      clip(turn.text, MAX_TURN_CHARS)
  );
  return (
    "\n\nCONVERSATION SO FAR (most recent last — the latest request " +
    "continues this thread):\n" +
    lines.join("\n\n")
  );
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
