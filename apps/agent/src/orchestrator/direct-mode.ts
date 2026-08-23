import type { TaskOptions } from "./orchestrator.js";

/**
 * Direct mode: the composer's "System knowledge" checkbox, unticked.
 *
 * With it ON (the default, and the absence of the flag) a task runs the
 * full pipeline — intent, retrieval, impact, plan, validation, review,
 * session memory. With it OFF the turn is a plain Claude or Codex agent
 * loop over the workspace: no RAG, no graph, no blast radius, no plan
 * tracking, no memory written or recalled. The only things that survive
 * are the ones that are not knowledge at all — the workspace layout, the
 * user's own hooks, and the consent gates (git flow, database approval).
 */
export function isDirectMode(opts: TaskOptions): boolean {
  return opts.systemKnowledge === false;
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
  "run_terminal",
];

/**
 * The rules a direct turn carries instead of SYSTEM_RULES. Everything that
 * described the knowledge engine is gone; what remains is the environment
 * the model is actually in — nobody to answer it, a workspace it may not
 * leave, and two hooks that will stop it and ask the user.
 */
export const DIRECT_RULES =
  "SYSTEM KNOWLEDGE OFF: this turn deliberately runs without Atelier's " +
  "knowledge engine — no retrieval, no impact analysis, no plan tracking, " +
  "no session memory. Work from the workspace itself: search and read the " +
  "files you need, then make the change.\n" +
  "CHEAPEST CHECK FIRST: when something does not work, run the smallest " +
  "decisive check before theorising about a cause. Is the process alive, " +
  "is the port listening, is the container up, does the file exist, what " +
  "does the command return RIGHT NOW. Only after those come config, env " +
  "and code. A log file, a cached output or an earlier run is HISTORY, " +
  "never proof of the current state — never cite one as evidence that " +
  "something is running. Name a cause only once a check you ran this turn " +
  "confirmed it; otherwise say which check you are running next.\n" +
  "AUTONOMOUS EXECUTION: you are running unattended — nobody is there to " +
  "answer you mid-turn. Never end a turn by asking whether to proceed or " +
  "by offering to implement. Where something is genuinely ambiguous, " +
  "choose the most reasonable default, state it in one line as an " +
  "assumption, and build it.\n" +
  "WORKSPACE BOUNDARY: use workspace-relative paths for project work. " +
  "Installed skills are runtime instructions, not project files: read " +
  "their SKILL.md and any referenced resources from their registered " +
  "external paths without treating them as part of the workspace or its " +
  "project/folder lock. A path the user explicitly named outside the " +
  "workspace is likewise an authorized read-only reference: read it " +
  "directly without asking the user to widen the workspace. Do not search " +
  "other external locations, and do not create, modify, delete, or run " +
  "commands outside the workspace.\n" +
  "GIT FLOW RULE (enforced by a blocking hook): never commit, push, or " +
  "open a pull request yourself — not with the git tool, not through " +
  "run_terminal. Staging, status, log and diff are fine. When the work " +
  "is ready, say so and let the user run the commit → push → PR wizard.\n" +
  "DATABASE RULE (enforced by an approval hook): when the task needs a " +
  "migration or DB command RUN, actually run it — the run_terminal call " +
  "pauses in an approval modal where the user approves or cancels; that " +
  "prompt IS how you ask permission. Only after the user cancels do you " +
  "stop and explain.\n" +
  "REPORTING: the process rail already shows every read/search/edit as it " +
  "happens, so do NOT narrate each step in prose as you go. Save your " +
  "explanation for ONE final report written LAST, as markdown bullet " +
  "points — one '- ' bullet per change or finding.\n";

/** How many prior turns ride along as plain conversation history. */
const MAX_PRIOR_TURNS = 4;

/** A prior turn is quoted this far and no further. */
const MAX_TURN_CHARS = 1200;

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
