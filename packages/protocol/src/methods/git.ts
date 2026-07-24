import { z } from "zod";
import {
  GitBranch,
  GitCommit,
  GitFlowInfo,
  GitOpResult,
  GitStatus,
} from "../models/git.js";

export const gitMethods = {
  "git.status": {
    params: z.object({}).optional(),
    result: z.object({ status: GitStatus }),
  },
  "git.log": {
    params: z.object({ maxCount: z.number().optional() }).optional(),
    result: z.object({ commits: z.array(GitCommit) }),
  },
  "git.diff": {
    params: z.object({
      path: z.string().optional(),
      staged: z.boolean().optional(),
      ref: z.string().optional(),
    }),
    // before/after carry full file contents when a single path is
    // requested, so the UI can render a side-by-side DiffEditor.
    result: z.object({
      diff: z.string(),
      before: z.string().optional(),
      after: z.string().optional(),
    }),
  },
  "git.stage": {
    params: z.object({ paths: z.array(z.string()) }),
    result: z.object({}),
  },
  "git.unstage": {
    params: z.object({ paths: z.array(z.string()) }),
    result: z.object({}),
  },
  "git.discard": {
    params: z.object({ paths: z.array(z.string()) }),
    result: z.object({}),
  },
  "git.commit": {
    params: z.object({ message: z.string() }),
    result: z.object({ hash: z.string() }),
  },
  "git.branches": {
    params: z.object({}).optional(),
    result: z.object({ branches: z.array(GitBranch) }),
  },
  "git.checkout": {
    params: z.object({ ref: z.string(), create: z.boolean().optional() }),
    result: z.object({}),
  },
  // Creates a private GitHub repo for the workspace via the gh CLI and
  // wires it up as `origin`. Returns the new remote URL.
  "git.connectRemote": {
    params: z.object({}).optional(),
    result: z.object({ url: z.string() }),
  },
  // Drafts a commit message from the current changes with Claude Haiku.
  // The UI puts it in the commit box where the user can edit it.
  "git.generateCommitMessage": {
    params: z.object({}).optional(),
    result: z.object({ message: z.string() }),
  },

  // ── Commit → push → PR wizard ─────────────────────────────────────────
  // "Run" methods spawn the real git/gh CLI so hooks execute, and stream
  // interleaved stdout+stderr to the caller via progress.chunk frames.

  "git.flowInfo": {
    params: z.object({}).optional(),
    result: z.object({ info: GitFlowInfo }),
  },
  // Haiku-suggested feature-branch name for the auto-branch step.
  "git.suggestBranchName": {
    params: z.object({}).optional(),
    result: z.object({ name: z.string() }),
  },
  // stageAll re-stages everything first (used after AI fixes touch files).
  "git.commitRun": {
    params: z.object({
      message: z.string(),
      stageAll: z.boolean().optional(),
    }),
    result: z.object({ result: GitOpResult }),
  },
  // Free-form flags (e.g. --no-verify); shape-validated server-side.
  "git.pushRun": {
    params: z.object({ flags: z.array(z.string()) }),
    result: z.object({ result: GitOpResult }),
  },
  "git.remoteBranches": {
    params: z.object({}).optional(),
    result: z.object({ branches: z.array(z.string()) }),
  },
  // Dry conflict probe (merge-tree) — does not touch the working tree.
  "git.checkConflicts": {
    params: z.object({ base: z.string() }),
    result: z.object({
      mergeable: z.boolean(),
      conflicts: z.array(z.string()),
    }),
  },
  // Real merge of origin/<base>; a conflicted exit is expected input for
  // the AI conflict-fix loop.
  "git.mergeRun": {
    params: z.object({ base: z.string() }),
    result: z.object({ result: GitOpResult }),
  },
  // Haiku-drafted PR title/body from commits vs the base branch.
  "git.generatePrDescription": {
    params: z.object({ base: z.string() }),
    result: z.object({ title: z.string(), body: z.string() }),
  },
  // gh pr create; head is the current branch. result.url on success.
  "git.createPr": {
    params: z.object({
      base: z.string(),
      title: z.string(),
      body: z.string(),
    }),
    result: z.object({ result: GitOpResult }),
  },
} as const;
