import type { SessionScope } from "./session-scope.js";

/**
 * The lock, stated as a hard boundary rather than a hint.
 *
 * This block is deliberately absolute. The soft version ("prefer these
 * folders") is what the layout block already tried, and a strong layout
 * prior beat it every time — the agent read badge.tsx out of two projects
 * the user never named. A rule the model can satisfy by reading "just one
 * more file elsewhere" is not a lock.
 *
 * `working` is this turn's live working set (see workingSet()), NOT the raw
 * anchor list. The two differ on exactly the turns that matter: a session
 * with forty touched files hands the model the handful it re-earned, and
 * the file the user named in this message is stated as the subject rather
 * than buried among them.
 */
export function renderScope(scope: SessionScope, working: string[]): string {
  if (scope.roots.length === 0 && working.length === 0) return "";

  const lines: string[] = [];

  if (scope.roots.length > 0) {
    const list = scope.roots.map((root) => `${root}/`).join(", ");
    lines.push(
      `SESSION SCOPE — LOCKED TO ${list}`,
      "Every path you read, search, edit, or run git against should start " +
        `with ${scope.roots.length === 1 ? "this prefix" : "one of these prefixes"}. ` +
        "A same-named file in another project is that project's copy, " +
        "never the one to read or edit — the guard refuses it. An existing " +
        "file outside the lock with NO same-named twin inside it is let " +
        "through when the work needs it (this is reported); creating files " +
        "outside the lock is refused.",
      "If the guard refuses a path the work genuinely needs, do not retry " +
        "it — finish everything else and name it as a blocker in the report."
    );
    if (scope.source === "inherited") {
      lines.push(
        "This lock came from an earlier turn and still applies — the user " +
          "does not have to repeat it on every message."
      );
    } else if (scope.source === "feature") {
      lines.push(
        "This lock came from the active feature matched in this session. " +
          "Keep follow-up work on that feature unless the user explicitly " +
          "names another feature or path."
      );
    }
  }

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
