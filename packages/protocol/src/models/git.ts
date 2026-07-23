import { z } from "zod";

export const GitFileStatus = z.object({
  path: z.string(),
  index: z.string(),
  workingDir: z.string(),
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

/** Outcome of a streamed git/gh command run (output arrives via progress). */
export const GitOpResult = z.object({
  ok: z.boolean(),
  exitCode: z.number(),
  /** Full interleaved stdout+stderr (ANSI-stripped, tail-capped). */
  output: z.string(),
  /** Set by git.createPr: the created pull-request URL. */
  url: z.string().optional(),
});
export type GitOpResult = z.infer<typeof GitOpResult>;

/** Everything the commit→push→PR wizard needs to pick its starting stage. */
export const GitFlowInfo = z.object({
  branch: z.string(),
  defaultBranch: z.string(),
  hasCommits: z.boolean(),
  hasUpstream: z.boolean(),
  hasRemote: z.boolean(),
});
export type GitFlowInfo = z.infer<typeof GitFlowInfo>;
