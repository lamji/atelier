import type { SessionScope } from "./session-scope.js";

/**
 * The working set, stated as the subject of the turn.
 *
 * This block once opened with "SESSION SCOPE — LOCKED TO <roots>" and a
 * guard behind it. Project locking was removed on 2026-08-29 (see
 * SessionScopeStore): the lock kept binding conversations to the wrong
 * project and the model reported the lock as its blocker. What is left is
 * the part that was always right — which files the user named and which
 * this conversation is already working on.
 *
 * `working` is this turn's live working set (see workingSet()), NOT the raw
 * anchor list. The two differ on exactly the turns that matter: a session
 * with forty touched files hands the model the handful it re-earned, and
 * the file the user named in this message is stated as the subject rather
 * than buried among them.
 */
export function renderScope(scope: SessionScope, working: string[]): string {
  if (working.length === 0) return "";

  const lines: string[] = [];

  // Named this turn: the subject, stated as such. Anything else in the
  // working set is a lead, and saying so is the point — the old block made
  // no distinction, so a file the agent edited by mistake three turns ago
  // read to the model exactly like a file the user had just pointed at.
  const named = working.filter((file) => scope.named.includes(file));
  const leads = working.filter((file) => !scope.named.includes(file));

  if (named.length > 0) {
    lines.push(
      "THE USER NAMED THESE PATHS IN THIS MESSAGE — they are the subject of " +
        "this turn. Read them before deciding what to change, and do not " +
        "edit somewhere else instead because it looked related:",
      ...named.map((file) => `- ${file}`)
    );
  }

  if (leads.length > 0) {
    lines.push(
      named.length > 0
        ? "Also open in this session (leads only — confirm against the paths " +
            "above before editing):"
        : "Files this conversation is already working on (a follow-up with " +
            "no path named usually means these — confirm the live owner " +
            "before editing):",
      ...leads.map((file) => `- ${file}`)
    );
  }

  return `${lines.join("\n")}\n`;
}
