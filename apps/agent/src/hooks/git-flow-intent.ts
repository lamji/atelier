import type { GitFlowOperation } from "@atelier/protocol";

export interface GitFlowIntent {
  operation: GitFlowOperation;
  /** Rendered form of the attempt, shown to the user in the modal. */
  command: string;
  commitMessage?: string;
}

/** Ordered so a compound command reports its FIRST flow step. */
const PATTERNS: Array<{ operation: GitFlowOperation; re: RegExp }> = [
  { operation: "commit", re: /\bgit\b[^\n&|;]*\bcommit\b/i },
  { operation: "push", re: /\bgit\b[^\n&|;]*\bpush\b/i },
  { operation: "pr", re: /\bgh\b[^\n&|;]*\bpr\b[^\n&|;]*\bcreate\b/i },
];

/** `-m "msg"`, `-m 'msg'`, `--message=msg`, or a bare `-m msg` token. */
const MESSAGE_RE =
  /(?:-m|--message)(?:\s+|=)(?:"([^"]*)"|'([^']*)'|([^\s"';|&]+))/;

/**
 * Recognises an attempt to run the git flow (commit / push / PR) from a
 * tool call, whether it goes through the `git` tool or a shell command.
 * Returns null for everything else — reads (status, log, diff), staging,
 * branch switching and non-git commands all stay untouched.
 */
export function detectGitFlowIntent(
  toolName: string,
  input: unknown
): GitFlowIntent | null {
  const i = (input ?? {}) as Record<string, unknown>;

  if (toolName === "git") {
    if (i.action !== "commit") return null;
    const message = typeof i.message === "string" ? i.message : undefined;
    return {
      operation: "commit",
      command: message ? `git commit -m "${message}"` : "git commit",
      commitMessage: message,
    };
  }

  if (toolName !== "run_terminal") return null;
  const command = typeof i.command === "string" ? i.command : "";
  if (!command) return null;

  // Earliest match wins so `git add -A && git push` reports the push and
  // `git commit && git push` reports the commit.
  let hit: { operation: GitFlowOperation; at: number } | null = null;
  for (const { operation, re } of PATTERNS) {
    const at = command.search(re);
    if (at >= 0 && (hit === null || at < hit.at)) hit = { operation, at };
  }
  if (!hit) return null;

  const matched = MESSAGE_RE.exec(command);
  const commitMessage = matched
    ? (matched[1] ?? matched[2] ?? matched[3])
    : undefined;
  return {
    operation: hit.operation,
    command: command.trim().slice(0, 400),
    commitMessage: hit.operation === "commit" ? commitMessage : undefined,
  };
}
