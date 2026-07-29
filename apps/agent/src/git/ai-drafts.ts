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
  model?: string
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
      model
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

/**
 * Drafts a PR title + body from the commits and diff between
 * origin/<base> and HEAD. Title is the first output line.
 */
export async function generatePrDescription(
  git: GitService,
  base: string,
  model?: string
): Promise<{ title: string; body: string }> {
  const root = git.root;
  const range = `origin/${base}...HEAD`;
  const [log, stat, diff] = await Promise.all([
    capture("git", ["log", "--oneline", `origin/${base}..HEAD`], root),
    capture("git", ["diff", "--stat", range], root),
    capture("git", ["diff", range], root),
  ]);

  const text = await oneShotDraft(
    "You write GitHub pull-request descriptions. Respond with ONLY the " +
      "PR content — no preamble, no fences. Line 1: a concise title (max " +
      "72 chars). Then a blank line, then a markdown body with a short " +
      "summary paragraph and a '## Changes' bullet list. Base the " +
      "content strictly on the provided commits and diff.",
    [
      `Commits vs ${base}:`,
      log.out || "(none)",
      "",
      "Diffstat:",
      stat.out || "(none)",
      "",
      "Diff:",
      truncate(diff.out, MAX_DIFF_CHARS) || "(empty)",
    ].join("\n"),
    model
  );

  const [first = "", ...rest] = text.split("\n");
  const title = first.trim() || "Update";
  const body = rest.join("\n").trim();
  return { title, body };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (diff truncated)`;
}
