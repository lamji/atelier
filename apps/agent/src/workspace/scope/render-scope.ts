import type { SessionScope } from "./session-scope.js";

/** Anchors shown to the model — enough to re-focus, not a file dump. */
const MAX_SHOWN_ANCHORS = 12;

/**
 * The lock, stated as a hard boundary rather than a hint.
 *
 * This block is deliberately absolute. The soft version ("prefer these
 * folders") is what the layout block already tried, and a strong layout
 * prior beat it every time — the agent read badge.tsx out of two projects
 * the user never named. A rule the model can satisfy by reading "just one
 * more file elsewhere" is not a lock.
 */
export function renderScope(scope: SessionScope): string {
  if (scope.roots.length === 0 && scope.anchors.length === 0) return "";

  const lines: string[] = [];

  if (scope.roots.length > 0) {
    const list = scope.roots.map((root) => `${root}/`).join(", ");
    lines.push(
      `SESSION SCOPE — LOCKED TO ${list}`,
      "Every path you read, search, edit, or run git against must start " +
        `with ${scope.roots.length === 1 ? "this prefix" : "one of these prefixes"}. ` +
        "Other projects in this workspace are OFF LIMITS this session, " +
        "even when they contain a file with the same name — a same-named " +
        "file elsewhere is a different project's copy, never the one to " +
        "read or edit.",
      "If the work genuinely requires a file outside the lock, say so and " +
        "ask; do not read it first and explain afterwards."
    );
    if (scope.source === "inherited") {
      lines.push(
        "This lock came from an earlier turn and still applies — the user " +
          "does not have to repeat it on every message."
      );
    }
  }

  if (scope.anchors.length > 0) {
    const shown = scope.anchors.slice(0, MAX_SHOWN_ANCHORS);
    lines.push(
      "Files this conversation is already working on (a follow-up with no " +
        "path named almost always means these):",
      ...shown.map((file) => `- ${file}`)
    );
  }

  return `${lines.join("\n")}\n`;
}
