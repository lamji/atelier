import { z } from "zod";
import {
  GitBranch,
  GitCommit,
  GitConflictFile,
  GitFlowInfo,
  GitOpResult,
  GitPullMode,
  GitRefs,
  GitRepo,
  GitStatus,
} from "../models/git.js";

export const gitMethods = {
  // Every checkout in the workspace. Empty only when there is genuinely no
  // repository anywhere below the opened folder.
  "git.repos": {
    params: z.object({}).optional(),
    result: z.object({
      repos: z.array(GitRepo),
      /** Active checkout path, or null when none is selected yet. */
      active: z.string().nullable(),
    }),
  },
  /** `git init` at the workspace root, for a workspace with no repo at all. */
  "git.init": {
    params: z.object({}).optional(),
    result: z.object({ root: z.string() }),
  },
  // Points the git panel (and unqualified git commands) at one checkout.
  "git.selectRepo": {
    params: z.object({ repo: z.string() }),
    result: z.object({ active: z.string() }),
  },
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
  // `remote`/`branch` push the current branch to an explicit target
  // (`git push <remote> HEAD:<branch>`); omitted = the tracked upstream.
  "git.pushRun": {
    params: z.object({
      flags: z.array(z.string()),
      remote: z.string().optional(),
      branch: z.string().optional(),
      setUpstream: z.boolean().optional(),
    }),
    result: z.object({ result: GitOpResult }),
  },
  /** Local + remote refs for the pull/push/checkout pickers (no network). */
  "git.refs": {
    params: z.object({}).optional(),
    result: z.object({ refs: GitRefs }),
  },
  /**
   * Streamed checkout. `track` names a remote ref ("origin/feat") to create
   * a local branch from when `ref` does not exist locally yet; `from` is
   * the start point a `create` branches out of (defaults to HEAD).
   */
  "git.checkoutRun": {
    params: z.object({
      ref: z.string(),
      create: z.boolean().optional(),
      track: z.string().optional(),
      from: z.string().optional(),
    }),
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

  // ── Sync + merge-conflict resolution ──────────────────────────────────
  // Pull is where conflicts are born; everything after it is the resolver.

  /** Quiet `git fetch`; the fresh ahead/behind is what the sync row shows. */
  "git.fetch": {
    params: z.object({}).optional(),
    result: z.object({ ahead: z.number(), behind: z.number() }),
  },
  /**
   * Streamed `git pull`. A conflicted exit is an expected outcome, not an
   * error: `conflicts` lists the files left unmerged so the UI can switch
   * straight into merge mode without a second round trip.
   */
  "git.pullRun": {
    params: z.object({
      mode: GitPullMode.optional(),
      /** Explicit source; omitted = the branch's tracked upstream. */
      remote: z.string().optional(),
      branch: z.string().optional(),
    }),
    result: z.object({
      result: GitOpResult,
      conflicts: z.array(z.string()),
    }),
  },
  /** All three sides + the marked-up working copy of one conflicted file. */
  "git.conflictFile": {
    params: z.object({ path: z.string() }),
    result: z.object({ file: GitConflictFile }),
  },
  /**
   * Writes the resolver's content to the working tree. `stage: true` also
   * `git add`s it, which is what tells git the conflict is resolved.
   */
  "git.resolveConflict": {
    params: z.object({
      path: z.string(),
      content: z.string(),
      stage: z.boolean(),
    }),
    result: z.object({}),
  },
  /** Take one whole side for each path (checkout --ours/--theirs + add). */
  "git.resolveConflictWith": {
    params: z.object({
      paths: z.array(z.string()),
      side: z.enum(["ours", "theirs"]),
    }),
    result: z.object({}),
  },
  /** Undo a resolution: puts the conflict markers back (checkout -m). */
  "git.restoreConflict": {
    params: z.object({ path: z.string() }),
    result: z.object({}),
  },
  /**
   * Which of `paths` still contain conflict markers on disk. The AI loop
   * asks this after a repair task ends, and stages only the clean ones.
   */
  "git.scanConflictMarkers": {
    params: z.object({ paths: z.array(z.string()) }),
    result: z.object({
      clean: z.array(z.string()),
      dirty: z.array(z.string()),
    }),
  },
  /** `git merge|rebase|cherry-pick|revert --abort`, per the state in flight. */
  "git.mergeAbort": {
    params: z.object({}).optional(),
    result: z.object({}),
  },
  /**
   * Streamed finish of the operation in flight: `git commit` for a merge
   * (with `message` when given, else the prepared MERGE_MSG), `--continue`
   * for the rest. git itself refuses while conflicts remain.
   */
  "git.mergeContinueRun": {
    params: z.object({ message: z.string().optional() }),
    result: z.object({ result: GitOpResult }),
  },
} as const;
