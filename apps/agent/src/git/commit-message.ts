import { oneShotDraft } from "./ai-drafts.js";
import { branchState, capture } from "./git-ops.js";
import type { GitService } from "./git-service.js";

/** Keeps the prompt well under Haiku's context window on huge changesets. */
const MAX_DIFF_CHARS = 40_000;

/**
 * Paths that mean a deploy needs a step beyond `git pull`.
 *
 * A migration missed at review time is found in production, so these are
 * pulled out of the file list and named in their own section rather than
 * left for the model to notice among two hundred other changed files.
 */
const MIGRATION_PATTERNS: RegExp[] = [
  /(^|\/)migrations?\//i,
  /(^|\/)db\/migrate\//i,
  /(^|\/)prisma\/migrations\//i,
  /(^|\/)alembic\/versions\//i,
  /(^|\/)supabase\/migrations\//i,
  /(^|\/)V\d+__.*\.sql$/i,
  /\.sql$/i,
  /(^|\/)schema\.(prisma|rb|sql)$/i,
  /(^|\/)knexfile\.[jt]s$/i,
];

export function isMigrationPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return MIGRATION_PATTERNS.some((pattern) => pattern.test(normalized));
}

const SYSTEM_PROMPT =
  "You write the single commit message that documents an entire branch, in " +
  "the style of release notes. The branch keeps ONE commit: when it grows, " +
  "that commit is amended and this message is EXTENDED, never started over. " +
  "When the input gives you the message the commit currently has, that " +
  "message is the document: keep its subject and every sentence and bullet " +
  "that is still true word for word, in the same order, and ADD what the " +
  "new uncommitted changes bring — new bullets under the right `## Changes` " +
  "area, new `## Migrations` entries, an extra line under Verification or " +
  "Breaking changes only if the new edit warrants one. Do not paraphrase, " +
  "reorder or compress what is already written. Change the subject line " +
  "only if the branch's purpose has genuinely changed. If the current " +
  "message is not in the format below, keep its wording and fit it into " +
  "the format. With no current message, describe the WHOLE branch as it " +
  "now stands — not only the newest edit.\n" +
  "Respond with ONLY the message. No preamble, no quotes, no markdown " +
  "fences around the whole thing.\n" +
  "\n" +
  "Format exactly:\n" +
  "<imperative subject line, at most 72 characters, no trailing period>\n" +
  "\n" +
  "# <Title of the work> — <the DATE you are given>\n" +
  "\n" +
  "## Summary\n" +
  "Two to four sentences: what this branch delivers and why. Plain words, " +
  "no restating of file names.\n" +
  "\n" +
  "## Changes\n" +
  "Group by area with `### ` subheadings (for example API, Database, UI, " +
  "Tooling) when there is more than one area. Under each, one bullet per " +
  "real change: what changed, in which file, and what it now does. Name " +
  "functions, endpoints, columns and flags exactly. Never write a bullet " +
  "that only repeats a file name.\n" +
  "\n" +
  "## Migrations\n" +
  "REQUIRED. If migration files are listed in the input, give one bullet " +
  "each: the full path in backticks, what it changes (tables, columns, " +
  "indexes, constraints), and whether it is reversible. Say plainly if one " +
  "must run before the code deploys. If there are none, write exactly: " +
  "`None.`\n" +
  "\n" +
  "## Verification\n" +
  "How this was or should be checked — commands, endpoints, screens. Keep " +
  "it to what the diff actually supports.\n" +
  "\n" +
  "## Breaking changes\n" +
  "Anything a caller, deploy, or config must change. If nothing, write " +
  "exactly: `None.`\n" +
  "\n" +
  "Be specific and readable. Do not invent changes the diff does not show, " +
  "and do not describe intent you cannot see — if the diff is truncated, " +
  "say so under Summary rather than guessing at the rest.";

/**
 * Drafts the branch's commit message with Claude Haiku (see ai-drafts.ts
 * for the model/auth rationale).
 *
 * Two things make this different from a per-change commit message. It is
 * written as dated release notes, because one commit per branch means this
 * text is the branch's whole documentation and someone will read it months
 * later to find out what shipped. And on a branch that already has its
 * commit, the input is the diff against the BASE, not just what is staged
 * — regenerating from the staged diff alone would describe the last edit
 * and silently drop everything the branch already did.
 */
export async function generateCommitMessage(
  git: GitService,
  model?: string
): Promise<string> {
  const context = await collectChangeContext(git);
  if (!context) {
    throw new Error("No changes to describe — the working tree is clean");
  }
  const message = await oneShotDraft(SYSTEM_PROMPT, context, model, git.root);
  if (!message) throw new Error("The model returned an empty message");
  return message;
}

/**
 * Builds the model input: the branch it is on, today's date, the changed
 * files, the migrations among them called out separately, and the diff.
 * Untracked files never appear in `git diff`, so the file list is what
 * tells the model about them. Returns null when there is nothing at all.
 */
async function collectChangeContext(git: GitService): Promise<string | null> {
  const status = await git.status();
  const branch = await branchState(git).catch(() => null);
  // Amending: the message must cover the branch, so diff against the base.
  const amending = Boolean(branch && branch.ahead === 1 && !branch.onBase);
  if (status.files.length === 0 && !amending) return null;

  const hasStaged = status.files.some((f) => f.index !== "" && f.index !== "?");
  const paths = status.files.map((f) => f.path);

  const { diff: stagedDiff } = await git.diff(undefined, true);
  const { diff: workingDiff } = hasStaged
    ? { diff: "" }
    : await git.diff(undefined, false);
  let diff = hasStaged ? stagedDiff : workingDiff;
  let branchDiff = "";
  let branchPaths: string[] = [];
  if (amending && branch) {
    const range = `origin/${branch.base}...HEAD`;
    branchDiff = await git.diff(undefined, false, range).then(
      (r) => r.diff,
      () => ""
    );
    branchPaths = await changedPathsIn(git, range);
  }

  const allPaths = [...new Set([...branchPaths, ...paths])];
  const migrations = allPaths.filter(isMigrationPath);

  const lines: string[] = [];
  lines.push(`Date: ${today()}`);
  if (branch?.branch) lines.push(`Branch: ${branch.branch}`);
  if (branch?.base) lines.push(`Merges into: ${branch.base}`);
  if (amending) {
    // "Replace" used to be the word here, and the model took it literally:
    // a one-line .env tweak came back as a freshly written message with the
    // branch's original notes paraphrased away. The commit is amended; the
    // message is appended to.
    const current = branch?.headMessage.trim() ?? "";
    lines.push(
      "This branch already has ONE commit, which will be amended (git " +
        "commit --amend) to include the uncommitted changes below. " +
        (current
          ? "Its current message follows. KEEP it and APPEND the new changes " +
            "to it: add bullets for them under the right `## Changes` area " +
            "(and `## Migrations` if any), leave everything already written " +
            "as it is, and keep the subject unless it no longer covers the " +
            "branch. The result must read as one message for the whole " +
            "branch, not as a note about the newest edit."
          : "It has no message to keep, so describe the committed work and " +
            "the uncommitted changes together as one release note.")
    );
    if (current) {
      lines.push("", "=== CURRENT COMMIT MESSAGE (keep) ===", current, "=== END ===");
    }
  }
  lines.push(
    "",
    hasStaged
      ? "Staged changes to be committed:"
      : "Working tree changes (nothing staged yet):",
    "",
    "Files (status codes: M=modified, A=added, D=deleted, R=renamed, ?=new):",
    status.files
      .map((f) => `${f.index || " "}${f.workingDir || " "} ${f.path}`)
      .join("\n") || "(none uncommitted)"
  );
  if (branchPaths.length > 0) {
    lines.push(
      "",
      `Files this branch already changed vs ${branch?.base}:`,
      branchPaths.map((p) => `- ${p}`).join("\n")
    );
  }
  lines.push(
    "",
    migrations.length > 0
      ? `MIGRATION FILES in this branch — every one of these MUST appear ` +
          `under "## Migrations" with its full path:\n` +
          migrations.map((p) => `- ${p}`).join("\n")
      : "No migration files were detected in this branch. Write `None.` " +
          "under `## Migrations`."
  );

  // The branch diff first: it is the larger story, and truncation should
  // eat the newest edit rather than the work that is already committed.
  const combined = [
    branchDiff ? `Diff of the existing commit vs ${branch?.base}:\n${branchDiff}` : "",
    diff ? `Diff of the uncommitted changes:\n${diff}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  lines.push(
    "",
    combined
      ? truncate(combined, MAX_DIFF_CHARS)
      : "(no textual diff — new/untracked files only)"
  );
  return lines.join("\n");
}

/** Paths touched in a revision range, for the branch-wide file list. */
async function changedPathsIn(
  git: GitService,
  range: string
): Promise<string[]> {
  const { code, out } = await capture(
    "git",
    ["diff", "--name-only", range],
    git.root
  ).catch(() => ({ code: -1, out: "" }));
  if (code !== 0 || !out) return [];
  return out.split(/\r?\n/).filter(Boolean);
}

/** Local calendar date, which is what a changelog entry is dated by. */
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (diff truncated)`;
}
