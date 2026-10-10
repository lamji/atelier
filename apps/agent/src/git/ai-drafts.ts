import { capture } from "./git-ops.js";
import type { GitService } from "./git-service.js";
import { runOneShot } from "../providers/one-shot.js";

/**
 * One-shot AI text drafts for the git flow (branch names, PR
 * descriptions, commit messages). Tool-less single turns, so they follow
 * the user's model choice: an Ollama selection runs on the local daemon,
 * anything else on Claude Haiku through the Agent SDK — where auth comes
 * from the Claude Code subscription login, same as the orchestrator.
 */

const HAIKU = "claude-haiku-4-5";
const TIMEOUT_MS = 60_000;

/**
 * Runs a single tool-less turn and returns the cleaned text. `model` is
 * the user's selected model id; omit it to stay on Haiku.
 */
export async function oneShotDraft(
  system: string,
  prompt: string,
  model?: string,
  /** Repository root — Codex runs `exec` there rather than in the agent's cwd. */
  cwd?: string
): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const text = await runOneShot({
      model,
      claudeFallback: HAIKU,
      system,
      prompt,
      signal: abort.signal,
      cwd,
    });
    return cleanDraft(text);
  } catch (error) {
    if (abort.signal.aborted) {
      throw new Error("AI draft generation timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Strips fences/quotes the model might add despite instructions. */
export function cleanDraft(raw: string): string {
  let text = raw.trim();
  const fence = text.match(/^```[a-z]*\n([\s\S]*?)\n?```$/);
  if (fence?.[1] !== undefined) text = fence[1].trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

const BRANCH_NAME_RE = /^[a-z0-9][a-z0-9/._-]*$/;

/**
 * Suggests a feature-branch name from the pending changes. Falls back to
 * a timestamped name when the model output isn't a valid ref name.
 */
export async function suggestBranchName(
  git: GitService,
  model?: string
): Promise<string> {
  const status = await git.status();
  const files = status.files
    .slice(0, 60)
    .map((f) => f.path)
    .join("\n");

  const fallback = timestampBranchName();
  if (!files) return fallback;

  try {
    const name = await oneShotDraft(
      "You name git branches. Given a list of changed files, respond with " +
        "ONLY a short kebab-case branch name prefixed with feat/, fix/, " +
        "chore/, or refactor/ — e.g. feat/git-flow-wizard. Lowercase " +
        "letters, digits, hyphens, and one slash only. No other text.",
      `Changed files:\n${files}`,
      model,
      git.root
    );
    const cleaned = name.toLowerCase().replace(/\s+/g, "-");
    return BRANCH_NAME_RE.test(cleaned) ? cleaned : fallback;
  } catch {
    return fallback;
  }
}

function timestampBranchName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `feat/changes-${now.getFullYear()}${pad(now.getMonth() + 1)}` +
    `${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  );
}

/** Keeps the prompt well under Haiku's context window on huge diffs. */
const MAX_DIFF_CHARS = 40_000;

/** One commit on the branch, message intact. */
interface BranchCommit {
  subject: string;
  body: string;
}

/**
 * Drafts the PR title and body for the commits between origin/<base> and
 * the head branch.
 *
 * The commit messages are the source, not the diff. Atelier's commit box
 * already writes a detailed message — and defaults to amend, so a branch
 * usually carries ONE commit that documents the whole change — while
 * re-describing the same diff from scratch produced a second, differently
 * worded account of the same work. Two descriptions that disagree in
 * emphasis is the failure mode; reusing the commit keeps the PR and the
 * history saying the same thing, costs no model call in the common case,
 * and cannot invent anything the author did not write.
 *
 * The diff-reading draft remains for the one case the commits cannot
 * serve: a branch whose commits are bare subject lines with no body.
 */
export async function generatePrDescription(
  git: GitService,
  base: string,
  model?: string,
  head?: string
): Promise<{ title: string; body: string }> {
  const root = git.root;
  // The head as GitHub will see it. A compare screen can name a branch the
  // user is not standing on, and describing HEAD then would describe the
  // wrong thing entirely.
  const headRef = head
    ? (await hasRef(root, `origin/${head}`))
      ? `origin/${head}`
      : head
    : "HEAD";
  // `origin/<base>` is the honest comparison — the base as it exists on the
  // remote is what the PR actually merges into. When that ref is missing (a
  // base never pushed, or a fetch that has not happened) fall back to the
  // local branch rather than silently producing an empty range.
  const ref = (await hasRef(root, `origin/${base}`))
    ? `origin/${base}`
    : (await hasRef(root, base))
      ? base
      : null;
  if (!ref) {
    throw new Error(
      `Cannot describe this pull request: neither origin/${base} nor ` +
        `${base} exists in this checkout. Fetch, or pick another base.`
    );
  }

  const commits = await branchCommits(root, ref, headRef);
  // An empty range is not a description problem, and asking the model to
  // write one anyway is asking it to invent. Every wrong PR body starts
  // with a range that said nothing.
  if (commits.length === 0) {
    throw new Error(
      `Nothing to describe: ${ref}..${headRef} is empty. This branch has no ` +
        `commits that ${base} does not already have.`
    );
  }

  const reused = await describeFromCommits(commits, model, root);
  if (reused) return reused;
  return describeFromDiff(root, base, ref, headRef, head, model);
}

/**
 * Reads the branch's own commits with their full messages.
 *
 * Field and record separators are the ASCII ones rather than newlines,
 * because a commit body is arbitrary multi-line text and any printable
 * delimiter is text somebody will eventually write in a commit.
 */
async function branchCommits(
  root: string,
  ref: string,
  headRef: string
): Promise<BranchCommit[]> {
  const { out } = await capture(
    "git",
    ["log", "--reverse", "--format=%x1e%s%x1f%b", `${ref}..${headRef}`],
    root
  );
  return out
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [subject = "", body = ""] = record.split("\x1f");
      return { subject: subject.trim(), body: body.trim() };
    })
    .filter((commit) => commit.subject.length > 0);
}

/**
 * Builds the description out of the commit messages themselves.
 *
 * @returns null when no commit carries a body — a list of bare subject
 * lines is not a description, and the diff-reading draft serves that case
 * better than a bullet list pretending to be one.
 */
async function describeFromCommits(
  commits: BranchCommit[],
  model: string | undefined,
  root: string
): Promise<{ title: string; body: string } | null> {
  if (!commits.some((commit) => commit.body)) return null;

  const [only] = commits;
  if (commits.length === 1 && only) {
    // The single-commit branch, which is what Atelier's amend default
    // produces: the commit message IS the pull request, verbatim.
    return { title: only.subject, body: only.body };
  }

  const body = commits
    .map((commit) =>
      commit.body ? `## ${commit.subject}\n\n${commit.body}` : `## ${commit.subject}`
    )
    .join("\n\n");
  return { title: await titleForCommits(commits, model, root), body };
}

/**
 * One line covering several commits.
 *
 * The subjects alone are enough context, so this never sends a diff. A
 * model that is unavailable, slow or wrong-shaped falls back to the last
 * commit's subject, which is a worse title but never a fabricated one.
 */
async function titleForCommits(
  commits: BranchCommit[],
  model: string | undefined,
  root: string
): Promise<string> {
  const fallback = commits[commits.length - 1]?.subject ?? "Update";
  try {
    const drafted = await oneShotDraft(
      "You title GitHub pull requests. Given the commit subjects of one " +
        "branch, respond with ONLY a single title line of at most 72 " +
        "characters that covers them. No preamble, no fences, no trailing " +
        "period. Do not introduce work the subjects do not mention.",
      commits.map((commit) => `- ${commit.subject}`).join("\n"),
      model,
      root
    );
    const title = drafted.split("\n")[0]?.trim() ?? "";
    return title && title.length <= 120 ? title : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The original draft: read the diff and write a description.
 *
 * Reached only when the branch's commits have no bodies to reuse.
 */
async function describeFromDiff(
  root: string,
  base: string,
  ref: string,
  headRef: string,
  head: string | undefined,
  model?: string
): Promise<{ title: string; body: string }> {
  const range = `${ref}...${headRef}`;
  const [log, stat, diff] = await Promise.all([
    capture("git", ["log", "--oneline", `${ref}..${headRef}`], root),
    capture("git", ["diff", "--stat", range], root),
    capture("git", ["diff", range], root),
  ]);

  const text = await oneShotDraft(
    "You write GitHub pull-request descriptions. Respond with ONLY the " +
      "PR content — no preamble, no fences. Line 1: a concise title (max " +
      "72 chars). Then a blank line, then a markdown body with a short " +
      "summary paragraph and a '## Changes' bullet list.\n" +
      "Describe ONLY this branch's own commits, listed below. Every bullet " +
      "must correspond to a file in the diffstat. Do not describe work the " +
      "base branch already contains, do not infer a larger programme of " +
      "work from file or directory names, and never widen a narrow change " +
      "into an architectural one. Few small commits mean a short " +
      "description — that is the correct outcome, not a gap to fill.\n" +
      "If the diff says it was truncated, say so in one line at the end " +
      "rather than guessing at the rest.",
    [
      `This pull request merges ${head ?? "the current branch"} into ` +
        `${base}, and`,
      `contains ONLY the ${countCommits(log.out)} commit(s) below.`,
      "",
      `Commits (${ref}..${headRef}):`,
      log.out || "(none)",
      "",
      "Files changed — every bullet must map to one of these:",
      stat.out || "(none)",
      "",
      "Diff:",
      truncate(diff.out, MAX_DIFF_CHARS) || "(empty)",
    ].join("\n"),
    model,
    root
  );

  const [first = "", ...rest] = text.split("\n");
  const title = first.trim() || "Update";
  const body = rest.join("\n").trim();
  return { title, body };
}

/** Whether a ref resolves to a commit in this checkout. */
async function hasRef(root: string, ref: string): Promise<boolean> {
  const { code } = await capture(
    "git",
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    root
  );
  return code === 0;
}

function countCommits(log: string): number {
  return log.split(/\r?\n/).filter((line) => line.trim()).length;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (diff truncated)`;
}
