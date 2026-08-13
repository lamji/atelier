import { z } from "zod";

export const GitFileStatus = z.object({
  path: z.string(),
  index: z.string(),
  workingDir: z.string(),
  /**
   * Opaque "has the file on disk moved" mark (size + mtime), or absent when
   * the file cannot be stat'd. Status marks alone cannot answer that — a
   * file stays " M" no matter how many times it is rewritten — so this is
   * what lets a caller tell one session's edits from the dirt that was
   * already there. Compare for equality only; the encoding is not a
   * contract. Optional: an older agent simply does not send it.
   */
  mark: z.string().optional(),
});
export type GitFileStatus = z.infer<typeof GitFileStatus>;

export const GitStatus = z.object({
  branch: z.string(),
  ahead: z.number(),
  behind: z.number(),
  files: z.array(GitFileStatus),
  isClean: z.boolean(),
  /** False when the repo has no remotes configured (never pushed anywhere). */
  hasRemote: z.boolean(),
});
export type GitStatus = z.infer<typeof GitStatus>;

export const GitCommit = z.object({
  hash: z.string(),
  message: z.string(),
  author: z.string(),
  date: z.string(),
  refs: z.string().optional(),
});
export type GitCommit = z.infer<typeof GitCommit>;

export const GitBranch = z.object({
  name: z.string(),
  current: z.boolean(),
});
export type GitBranch = z.infer<typeof GitBranch>;

/**
 * One checkout inside the workspace. A company folder holding several
 * project repos has no repository of its own, so the UI needs the list to
 * show rather than a single implied repo that does not exist.
 */
export const GitRepo = z.object({
  /** Workspace-relative directory ("." when the root is itself a repo). */
  path: z.string(),
  /** Folder name, for the tab label. */
  name: z.string(),
  /** Current branch, or null when it could not be read. */
  branch: z.string().nullable(),
  /** Uncommitted file count, for the tab badge. */
  changedFiles: z.number(),
  /** The checkout git commands currently act on. */
  active: z.boolean(),
});
export type GitRepo = z.infer<typeof GitRepo>;

/** Outcome of a streamed git/gh command run (output arrives via progress). */
export const GitOpResult = z.object({
  ok: z.boolean(),
  exitCode: z.number(),
  /** Full interleaved stdout+stderr (ANSI-stripped, tail-capped). */
  output: z.string(),
  /** Set by git.createPr: the created pull-request URL. */
  url: z.string().optional(),
  /**
   * Set by git.createPr when it FAILED: the github.com compare page for
   * the same branch, so a `gh` problem (wrong account, missing scope, SSO)
   * still leaves the user one click from opening the PR by hand.
   */
  fallbackUrl: z.string().optional(),
});
export type GitOpResult = z.infer<typeof GitOpResult>;

/** The step of the flow the agent tried to run on its own. */
export const GitFlowOperation = z.enum(["commit", "push", "pr"]);
export type GitFlowOperation = z.infer<typeof GitFlowOperation>;

/**
 * A git-flow step the agent was blocked from running by itself. Raised so
 * the UI can open the wizard and let the user drive commit → push → PR.
 */
export const GitFlowRequest = z.object({
  operation: GitFlowOperation,
  /** The command (or git tool call) the agent attempted, for display. */
  command: z.string(),
  /** Commit message parsed off the attempt, when it carried one. */
  commitMessage: z.string().optional(),
  reason: z.string(),
});
export type GitFlowRequest = z.infer<typeof GitFlowRequest>;

/** Everything the commit→push→PR wizard needs to pick its starting stage. */
export const GitFlowInfo = z.object({
  /**
   * The checkout this flow acts on, workspace-relative ("." when the
   * workspace root is itself the repo). Every command in the wizard runs
   * there, and the AI fix agent is confined to it.
   */
  repo: z.string(),
  branch: z.string(),
  defaultBranch: z.string(),
  hasCommits: z.boolean(),
  hasUpstream: z.boolean(),
  hasRemote: z.boolean(),
});
export type GitFlowInfo = z.infer<typeof GitFlowInfo>;
