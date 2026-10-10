import { z } from "zod";

/** Added/removed line counts for one side of a file's change. */
export const GitLineStat = z.object({
  added: z.number(),
  removed: z.number(),
  /** git reports "-" for binary files — the counts are 0 and meaningless. */
  binary: z.boolean().optional(),
});
export type GitLineStat = z.infer<typeof GitLineStat>;

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
  /**
   * Line delta of the STAGED side (HEAD → index) and of the WORKING side
   * (index → working tree). Kept apart because one file can have both, and
   * the panel shows it in both sections. Absent when the count could not
   * be taken (an older agent, or an untracked file too big to read).
   */
  indexStat: GitLineStat.optional(),
  workStat: GitLineStat.optional(),
});
export type GitFileStatus = z.infer<typeof GitFileStatus>;

/** Which multi-step operation left the repo mid-flight. */
export const GitMergeKind = z.enum(["merge", "rebase", "cherry-pick", "revert"]);
export type GitMergeKind = z.infer<typeof GitMergeKind>;

/**
 * An in-progress merge-like operation (MERGE_HEAD, rebase-merge/,
 * CHERRY_PICK_HEAD, REVERT_HEAD). Present whether or not conflicts remain:
 * "all resolved, not yet committed" is still this state.
 */
export const GitMergeState = z.object({
  kind: GitMergeKind,
  /** Human label for the side HEAD is on — what git calls "ours". */
  ours: z.string(),
  /** Human label for the side being brought in — git's "theirs". */
  theirs: z.string(),
  /** Message git prepared for the resulting commit (MERGE_MSG), if any. */
  message: z.string().optional(),
});
export type GitMergeState = z.infer<typeof GitMergeState>;

export const GitStatus = z.object({
  branch: z.string(),
  ahead: z.number(),
  behind: z.number(),
  files: z.array(GitFileStatus),
  isClean: z.boolean(),
  /** False when the repo has no remotes configured (never pushed anywhere). */
  hasRemote: z.boolean(),
  /**
   * Workspace-relative paths still unmerged in the index (every conflict
   * shape: UU, AA, DD, AU, UA, DU, UD). Empty when nothing is conflicted.
   */
  conflicts: z.array(z.string()),
  /** The merge/rebase/… in flight, or null when the repo is at rest. */
  mergeState: GitMergeState.nullable(),
});
export type GitStatus = z.infer<typeof GitStatus>;

/**
 * Everything the resolver needs for ONE conflicted file. Sides come from
 * the index stages (:1: base, :2: ours, :3: theirs); a side that does not
 * exist there (added on one side only, deleted on the other) is "".
 */
export const GitConflictFile = z.object({
  path: z.string(),
  base: z.string(),
  ours: z.string(),
  theirs: z.string(),
  /** Working-tree content — the file with conflict markers in it. */
  current: z.string(),
  oursLabel: z.string(),
  theirsLabel: z.string(),
  /** True once the index no longer lists the path as unmerged. */
  resolved: z.boolean(),
});
export type GitConflictFile = z.infer<typeof GitConflictFile>;

/** A configured remote. */
export const GitRemote = z.object({ name: z.string(), url: z.string() });
export type GitRemote = z.infer<typeof GitRemote>;

/**
 * Everything the pull/push/checkout pickers need, read from the local ref
 * store (no network — a Fetch button refreshes it). `remote` branches are
 * split into remote + branch so the pickers can filter by remote.
 */
export const GitRefs = z.object({
  current: z.string(),
  remotes: z.array(GitRemote),
  local: z.array(
    z.object({
      name: z.string(),
      /** "origin/main" when the branch tracks a remote branch. */
      upstream: z.string().nullable(),
    })
  ),
  remote: z.array(
    z.object({ ref: z.string(), remote: z.string(), branch: z.string() })
  ),
});
export type GitRefs = z.infer<typeof GitRefs>;

/** How `git pull` reconciles a diverged branch. */
export const GitPullMode = z.enum(["merge", "rebase", "ff-only"]);
export type GitPullMode = z.infer<typeof GitPullMode>;

export const GitCommit = z.object({
  hash: z.string(),
  /** Subject line only — what the log rows show. */
  message: z.string(),
  /**
   * Everything after the subject's blank line, verbatim.
   *
   * Carried because a commit message is often where the real account of a
   * change lives — GitHub shows it behind the "…" next to the subject —
   * and Atelier's own generated messages are release notes with sections
   * and migration paths in exactly this field. Without it the log could
   * only ever show the first line of what it wrote.
   */
  body: z.string().optional(),
  author: z.string(),
  /** Author's email, for the avatar/identity line in the detail view. */
  email: z.string().optional(),
  date: z.string(),
  refs: z.string().optional(),
  /**
   * Full hashes of the parent commits, first parent first. The History
   * graph draws its lanes from these; a merge has two or more.
   */
  parents: z.array(z.string()).optional(),
});
export type GitCommit = z.infer<typeof GitCommit>;

/** One file a commit touched, relative to its first parent. */
export const GitCommitFile = z.object({
  /** Repo-relative path after the commit. */
  path: z.string(),
  /** Repo-relative path before the commit, for a rename or copy. */
  oldPath: z.string().optional(),
  /** git's name-status letter: A, M, D, R, C or T. */
  status: z.string(),
  added: z.number(),
  removed: z.number(),
  binary: z.boolean().optional(),
});
export type GitCommitFile = z.infer<typeof GitCommitFile>;

/** One line of `git blame`, with the commit that last changed it. */
export const GitBlameLine = z.object({
  /** 1-based line number in the blamed revision. */
  line: z.number(),
  hash: z.string(),
  author: z.string(),
  email: z.string().optional(),
  date: z.string(),
  summary: z.string(),
  content: z.string(),
});
export type GitBlameLine = z.infer<typeof GitBlameLine>;

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

/** Which forge the `origin` remote points at — decides which CLI is asked. */
export const GitForge = z.enum(["github", "gitlab"]);
export type GitForge = z.infer<typeof GitForge>;

/**
 * Why the request list looks the way it does. Split out of the old
 * `available: false` plus a prose `reason`, because the pane's next
 * action differs per case and a sentence cannot be branched on: only
 * `signed-out` may ever suggest signing in.
 */
export const GitForgeStatus = z.enum([
  "ok",
  /** No `origin` remote at all — nothing to ask about. */
  "no-remote",
  /** origin is neither GitHub nor GitLab; there is no list to show. */
  "no-forge",
  /** No credential anywhere we look — the one sign-in case. */
  "signed-out",
  /** A credential answered and the forge rejected it (401/403). */
  "denied",
  /** Something else broke: network, rate limit, a CLI crash. */
  "error",
]);
export type GitForgeStatus = z.infer<typeof GitForgeStatus>;

/**
 * Which credential actually answered. Shown as a dot in the pane so
 * "am I logged in?" is answerable at a glance — and so the wrong-account
 * case (gh signed in as someone other than the push credential) is
 * visible rather than inferred.
 */
export const GitForgeAuthSource = z.enum([
  /** The forge's own CLI answered (`gh` / `glab`). */
  "cli",
  /** GITHUB_TOKEN / GH_TOKEN / GITLAB_TOKEN from the environment. */
  "env",
  /** A token handed over by the CLI, spent over REST. */
  "cli-token",
  /** git's own credential helper — the same login that pushes. */
  "credential-helper",
  /**
   * A token the user added through the Requests pane, kept by Atelier.
   *
   * Its own source because it is the only one Atelier is responsible for:
   * every other entry is discovered from somewhere the user already
   * manages, and this is the one they can expect the app to remember.
   */
  "stored",
]);
export type GitForgeAuthSource = z.infer<typeof GitForgeAuthSource>;

/**
 * One API-capable credential discovered on this machine. The id is opaque
 * and process-local: it lets the UI choose a credential without sending a
 * token across the bridge.
 */
export const GitForgeCredential = z.object({
  id: z.string(),
  source: GitForgeAuthSource,
  /** Account volunteered by gh/glab/git credential, when available. */
  login: z.string().optional(),
});
export type GitForgeCredential = z.infer<typeof GitForgeCredential>;

/**
 * One open pull request (GitHub) or merge request (GitLab). Deliberately
 * the small common shape of both CLIs: everything richer differs per forge
 * and the panel only ever shows a one-line row plus a couple of chips.
 */
export const GitPullRequest = z.object({
  /** PR/MR number — the id the user actually says out loud. */
  number: z.number(),
  title: z.string(),
  /** Login of whoever opened it, or "" when the CLI did not say. */
  author: z.string(),
  /** Source branch. */
  head: z.string(),
  /** Target branch. */
  base: z.string(),
  url: z.string(),
  draft: z.boolean(),
  /** ISO timestamp of the last update, for the relative age on the row. */
  updatedAt: z.string(),
  /** GitHub review state ("APPROVED", "CHANGES_REQUESTED", …) when known. */
  reviewDecision: z.string().optional(),
  /** Rolled-up CI state, normalised across forges. */
  checks: z.enum(["passing", "failing", "pending"]).optional(),
  /** True when this request's head branch is the current checkout's branch. */
  mine: z.boolean().optional(),
});
export type GitPullRequest = z.infer<typeof GitPullRequest>;

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
/**
 * What the current branch owns relative to its base — the facts the commit
 * box needs to decide between amending the branch's single commit and
 * starting a new one.
 */
export const GitBranchState = z.object({
  branch: z.string(),
  /** The branch this one will merge into ("main", "develop", …). */
  base: z.string(),
  /** Commits on this branch that are not on the base. */
  ahead: z.number(),
  /** True when HEAD is the base branch itself — never amend there. */
  onBase: z.boolean(),
  /** Amending something already pushed needs a force push. */
  hasUpstream: z.boolean(),
  headSubject: z.string(),
  /** Full message of HEAD, so an amend can start from what it already says. */
  headMessage: z.string(),
});
export type GitBranchState = z.infer<typeof GitBranchState>;

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
