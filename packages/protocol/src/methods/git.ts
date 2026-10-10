import { z } from "zod";
import {
  GitBranch,
  GitBlameLine,
  GitBranchState,
  GitCommit,
  GitCommitFile,
  GitConflictFile,
  GitFlowInfo,
  GitForge,
  GitForgeAuthSource,
  GitForgeCredential,
  GitForgeStatus,
  GitOpResult,
  GitPullMode,
  GitPullRequest,
  GitRefs,
  GitRepo,
  GitStatus,
} from "../models/git.js";

/**
 * The answer both `git.pullRequests` and `git.forgeConnect` give. Shared
 * so the Connect button can drop its result straight into the pane's
 * state without a second shape to reconcile.
 */
const GitPullRequestList = z.object({
  requests: z.array(GitPullRequest),
  /** null when origin is not a forge this can query. */
  forge: GitForge.nullable(),
  /** Kept for callers that only ask "is there a list?" — `status === "ok"`. */
  available: z.boolean(),
  /** Why the list is empty. Prose, for display only — branch on `status`. */
  reason: z.string().optional(),
  status: GitForgeStatus,
  /** Which credential answered; absent when none did. */
  source: GitForgeAuthSource.optional(),
  /** API-capable credentials discovered from CLI, env and git helper. */
  credentials: z.array(GitForgeCredential),
  /** "owner/name" on the forge, for the pane's status strip. */
  repo: z.string().optional(),
  /** Account the answering credential belongs to, when it named one. */
  login: z.string().optional(),
  /** Forge host, so a self-hosted GitLab names itself. */
  host: z.string().optional(),
  /** Branch the checkout is on, so the UI can mark "yours". */
  branch: z.string().optional(),
});

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
    params: z
      .object({
        maxCount: z.number().optional(),
        /** Every branch, tag and remote ref, not just HEAD's ancestry. */
        all: z.boolean().optional(),
        /** One local or remote branch ref to walk without checking it out. */
        ref: z.string().optional(),
        /** Repo-relative file: that file's history, following renames. */
        path: z.string().optional(),
      })
      .optional(),
    result: z.object({ commits: z.array(GitCommit) }),
  },
  // Files a commit changed against its first parent (the empty tree for a
  // root commit). Paths are repo-relative to the active checkout.
  "git.commitFiles": {
    params: z.object({ hash: z.string() }),
    result: z.object({
      files: z.array(GitCommitFile),
      parents: z.array(z.string()),
    }),
  },
  // Full contents of one file on both sides of a commit, for a diff view.
  "git.commitFileDiff": {
    params: z.object({
      hash: z.string(),
      path: z.string(),
      oldPath: z.string().optional(),
    }),
    result: z.object({ before: z.string(), after: z.string() }),
  },
  // `git blame` of a repo-relative file at a revision (working tree when
  // `ref` is absent).
  "git.blame": {
    params: z.object({ path: z.string(), ref: z.string().optional() }),
    result: z.object({ lines: z.array(GitBlameLine) }),
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
    params: z.object({
      message: z.string(),
      /**
       * Rewrite HEAD instead of adding a commit. The commit box defaults
       * it on once the branch owns exactly one commit, so a branch stays
       * one dated changelog entry rather than a trail of fixups.
       */
      amend: z.boolean().optional(),
    }),
    result: z.object({ hash: z.string() }),
  },
  /**
   * Adds a second forge account from a token the user pastes, after
   * verifying with the forge which account it belongs to. Handed to gh so
   * it persists; Atelier never writes credentials to disk itself.
   */
  "git.addForgeAccount": {
    params: z.object({ token: z.string() }),
    result: z.object({
      ok: z.boolean(),
      login: z.string().optional(),
      persisted: z.boolean(),
      reason: z.string().optional(),
    }),
  },
  // Facts the commit box needs to choose amend vs new commit.
  "git.branchState": {
    params: z.object({}).optional(),
    result: z.object({ state: GitBranchState }),
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
    params: z
      .object({
        /** Model id the draft runs on; absent means the app's selected model. */
        model: z.string().optional(),
      })
      .optional(),
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
    params: z
      .object({
        /** Model id the suggestion runs on; absent means the app's selected model. */
        model: z.string().optional(),
      })
      .optional(),
    result: z.object({ name: z.string() }),
  },
  // stageAll re-stages everything first (used after AI fixes touch files).
  "git.commitRun": {
    params: z.object({
      message: z.string(),
      stageAll: z.boolean().optional(),
      /** Rewrite the branch's existing commit instead of adding one. */
      amend: z.boolean().optional(),
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
  // AI-drafted PR title/body from commits vs the base branch.
  "git.generatePrDescription": {
    params: z.object({
      base: z.string(),
      /** Branch to describe. Absent means the current checkout. */
      head: z.string().optional(),
      /**
       * Model id the draft runs on (any provider the picker lists). Absent
       * means the app's selected model, which used to be the only option.
       */
      model: z.string().optional(),
    }),
    result: z.object({ title: z.string(), body: z.string() }),
  },
  // gh pr create. result.url on success.
  "git.createPr": {
    params: z.object({
      base: z.string(),
      /**
       * Branch to merge FROM. Absent means the current checkout, which is
       * what the wizard sends; the compare screen names it explicitly so a
       * request can be opened for a branch you are not standing on.
       */
      head: z.string().optional(),
      title: z.string(),
      body: z.string(),
      /**
       * Which forge account opens the PR — an opaque id from
       * `git.prCredentials`. Omit to let Atelier match the account this
       * checkout pushes as, which is the right answer on a machine with
       * more than one GitHub login.
       */
      credentialId: z.string().optional(),
    }),
    result: z.object({ result: GitOpResult }),
  },

  /**
   * Forge accounts that could open a pull request for `origin`, best
   * first, plus the one the checkout's own git identity points at.
   *
   * Read by the describe screen's account picker. Tokens never leave the
   * agent; the browser only ever sees the opaque ids.
   */
  "git.prCredentials": {
    params: z.object({}).optional(),
    result: z.object({
      credentials: z.array(GitForgeCredential),
      /** Credential matching the account git pushes as, when there is one. */
      suggestedId: z.string().optional(),
      /** Login git authenticates as on this checkout. */
      identity: z.string().optional(),
      host: z.string().optional(),
      repo: z.string().optional(),
    }),
  },

  /**
   * Open pull requests (GitHub) or merge requests (GitLab) for `origin`,
   * read through whichever credential answers first — the forge CLI, a
   * token in the environment, or git's own credential helper. Polled by
   * the panel, so nothing here throws: `status` says why the list is
   * empty and the pane picks its next action from that.
   */
  "git.pullRequests": {
    params: z
      .object({
        /** Opaque id from result.credentials; omit to try credentials automatically. */
        credentialId: z.string().optional(),
      })
      .optional(),
    result: GitPullRequestList,
  },

  /**
   * Forget every cached forge token and probe the credentials again.
   * What the pane's "Connect" button runs: the usual cause of a
   * signed-out pane is a login that happened after the agent started.
   */
  "git.forgeConnect": {
    params: z.object({ credentialId: z.string().optional() }).optional(),
    result: GitPullRequestList,
  },

  // ── Sync + merge-conflict resolution ──────────────────────────────────
  // Pull is where conflicts are born; everything after it is the resolver.

  /** Quiet `git fetch`; the fresh ahead/behind is what the sync row shows. */
  /** `git fetch --all --prune --tags`: refs only, nothing merged. */
  "git.fetch": {
    params: z.object({}).optional(),
    result: z.object({
      ahead: z.number(),
      behind: z.number(),
      /** Remote-tracking refs the fetch moved. */
      updated: z.number().optional(),
    }),
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
  /**
   * Streamed `git rebase <onto>`, replaying the current branch on top of
   * another. Like a pull, a conflicted exit is an expected outcome and
   * comes back with the unmerged paths rather than as an error.
   *
   * `keep` picks the automatic resolution. Git's -X flags are named from
   * the rebase's point of view, where "ours" is the branch being replayed
   * ONTO and "theirs" is the work being replayed — the opposite of what
   * the words mean to the person rebasing — so this asks for the side in
   * plain terms and the agent maps it: "mine" (the branch's own commits)
   * is -X theirs, "base" is -X ours, "none" stops for the resolver.
   */
  "git.rebaseRun": {
    params: z.object({
      /** Ref to replay onto, e.g. "main" or "origin/main". */
      onto: z.string(),
      keep: z.enum(["mine", "base", "none"]).optional(),
      /** Fetch this remote's copy of `onto` before starting. */
      remote: z.string().optional(),
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
