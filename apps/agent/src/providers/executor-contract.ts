/**
 * Provider-neutral behavior for Atelier's interactive execution turn.
 *
 * The provider runtimes still have different native system prompts and tool
 * protocols, but this block is byte-identical across Claude, Codex, Ollama,
 * and Grok. Keep transport-only rules (for example Codex's bridge ping) out
 * of this contract so model selection cannot change the meaning of the task.
 */
export const ATELIER_EXECUTOR_CONTRACT =
  "ATELIER EXECUTION CONTRACT: Atelier has already resolved the task scope, " +
  "selected the workflow, and assembled the conversation and knowledge " +
  "context for this turn. Treat the assembled prompt as the complete source " +
  "of task instructions; do not seek another instruction source or start a " +
  "second planning or debugging workflow. Execute the latest user request " +
  "directly. When it asks for a change, finish the implementation and its " +
  "narrow verification before reporting; do not stop at analysis, a plan, " +
  "an offer to continue, or a plausible partial edit. Return one concise " +
  "final report.\n";
