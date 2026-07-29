import { oneShotDraft } from "./ai-drafts.js";
import type { GitService } from "./git-service.js";

/** Keeps the prompt well under Haiku's context window on huge changesets. */
const MAX_DIFF_CHARS = 40_000;

const SYSTEM_PROMPT =
  "You write git commit messages. Given a summary of changed files and " +
  "diffs, respond with ONLY the commit message — no preamble, no quotes, " +
  "no markdown fences. Format: an imperative subject line of at most 72 " +
  "characters; optionally, after a blank line, a short body (up to 5 " +
  "bullet lines) when the change is large or spans several concerns.";

/**
 * Drafts a commit message from the repo's current changes with Claude
 * Haiku (see ai-drafts.ts for the model/auth rationale). Prefers the
 * staged diff (that is what will be committed); falls back to the full
 * working-tree state when nothing is staged. The result goes into the
 * commit box on the UI, where the user can still edit it.
 */
export async function generateCommitMessage(
  git: GitService,
  model?: string
): Promise<string> {
  const context = await collectChangeContext(git);
  if (!context) {
    throw new Error("No changes to describe — the working tree is clean");
  }
  const message = await oneShotDraft(SYSTEM_PROMPT, context, model);
  if (!message) throw new Error("The model returned an empty message");
  return message;
}

/**
 * Builds the model input: a file list with status codes plus the relevant
 * diff. Untracked files never appear in `git diff`, so the file list is
 * what tells the model about them. Returns null when there is nothing.
 */
async function collectChangeContext(git: GitService): Promise<string | null> {
  const status = await git.status();
  if (status.files.length === 0) return null;

  const hasStaged = status.files.some(
    (f) => f.index !== "" && f.index !== "?"
  );
  const fileList = status.files
    .map((f) => `${f.index || " "}${f.workingDir || " "} ${f.path}`)
    .join("\n");

  const { diff: stagedDiff } = await git.diff(undefined, true);
  const { diff: workingDiff } = hasStaged
    ? { diff: "" }
    : await git.diff(undefined, false);
  const diff = truncate(hasStaged ? stagedDiff : workingDiff, MAX_DIFF_CHARS);

  return [
    hasStaged
      ? "Staged changes to be committed:"
      : "Working tree changes (nothing staged yet):",
    "",
    "Files (status codes: M=modified, A=added, D=deleted, R=renamed, ?=new):",
    fileList,
    "",
    diff ? `Diff:\n${diff}` : "(no textual diff — new/untracked files only)",
  ].join("\n");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (diff truncated)`;
}
