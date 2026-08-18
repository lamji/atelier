---
feature: chat flow
slug: chat-flow
status: stale
updated: 2026-08-08T13:50:42.264Z
aliases:
  - git flow
  - "commit-push-pr wizard"
  - git wizard
  - flow modal
  - git modal
  - git flow hook
  - ai fix chat
  - git fix loop
sources:
  - "apps/web/src/views/git/GitPanel.tsx @ 1785484425593 @ 25e51ce0a33f"
  - "apps/web/src/views/git/GitFlowModal.tsx @ 1785397157785 @ bfc413a23857"
  - "apps/web/src/views/git/GitFlowHost.tsx @ 1784855716942 @ 74c6355fd6a5"
  - "apps/web/src/hooks/useGitFlowViewModel.ts @ 1785319162601 @ c64e0d148af5"
  - "apps/web/src/state/git-flow.store.ts @ 1785319152040 @ ed72d7fa7ce6"
  - "apps/web/src/services/event-dispatcher.ts @ 1786196960672 @ 8980f76dbf46"
  - "apps/web/src/services/bridge-client.ts @ 1785430180622 @ cbd3be047ed2"
  - "apps/agent/src/git/register-git-handlers.ts @ 1785484383830 @ e66c9d6e58c3"
  - "apps/agent/src/git/git-ops.ts @ 1785762266069 @ b6c4e2a98807"
  - "apps/agent/src/git/git-service.ts @ 1785484359756 @ 710a9932bcde"
  - "apps/agent/src/git/ai-drafts.ts @ 1785128265616 @ d01c6407c865"
  - "apps/agent/src/hooks/git-flow-intent.ts @ 1784854895377 @ 0c82b43c23cf"
  - "apps/agent/src/hooks/git-flow-guard.ts @ 1784854910026 @ 9b9ad6fab7f7"
  - "apps/agent/src/runtime.ts @ 1786085499886 @ 507d57398c82"
  - "packages/protocol/src/methods/git.ts @ 1785484378086 @ 7c7a33c56d2f"
  - "packages/protocol/src/models/git.ts @ 1785319045707 @ 2547e566eb5a"
  - "packages/protocol/src/models/conversation.ts @ 1786085603078 @ 3c7b18d51605"
  - "packages/protocol/src/events.ts @ 1786085608145 @ 453b8b60e7cd"
  - "apps/agent/src/orchestrator/trivial-chat.ts @ 1785418836565 @ f1e8b299c439"
---

# chat flow

The commit → push → PR wizard guides users through publishing changes to GitHub. It launches when the user clicks Commit in the Git panel, or when the agent tries to run git operations and is blocked. The wizard stages and commits changes, pushes to origin with hooks executing, then drafts and creates a pull request. If any step fails—a commit hook rejects the code, a push is rejected remotely, or a merge conflict appears—an embedded Sonnet 5 chat asks the AI to fix the problem. The user reviews the AI's edits, then the wizard re-runs the failed step. The flow supports multi-repo workspaces, suggests feature branches, detects merge conflicts, and offers a fallback compare URL when PR creation fails due to auth issues.

## Entry points

- `apps/web/src/views/git/GitPanel.tsx:165` — user enters commit message and clicks the Commit button
- `apps/agent/src/hooks/git-flow-guard.ts:55` — agent attempts commit/push/PR, hook publishes `git.flow.requested` event to block and open the modal

## Flow

1. `apps/web/src/views/git/GitPanel.tsx:165` — user clicks Commit button, triggering `doCommit()`
2. `apps/web/src/views/git/GitPanel.tsx:165` — `startFlow()` opens the modal and queries repo state
3. `apps/agent/src/git/register-git-handlers.ts:76-78` — agent handler for `git.flowInfo` reads branch, remote, commit history
4. `apps/web/src/hooks/useGitFlowViewModel.ts:144-166` — `startFlow()` validates repo (has remote, has commits, not on default branch)
5. `apps/web/src/hooks/useGitFlowViewModel.ts:157-161` — if on default branch, suggest feature branch name via `git.suggestBranchName` RPC
6. `apps/agent/src/git/ai-drafts.ts:59-74` — Haiku one-shot drafts a branch name from staged changes
7. `apps/web/src/hooks/useGitFlowViewModel.ts:182-192` — user confirms branch name, modal calls `git.checkout` to create it
8. `apps/web/src/hooks/useGitFlowViewModel.ts:69-74` — modal transitions to commit stage, calls `streamRun("git.commitRun")`
9. `apps/agent/src/git/register-git-handlers.ts:84-93` — handler stages files (if needed) and spawns `git commit -m`
10. `apps/agent/src/git/git-ops.ts:48-94` — `runStreaming()` executes git with hooks, streams ANSI-stripped output back via progress chunks
11. `apps/web/src/hooks/useGitFlowViewModel.ts:71-82` — if commit succeeds (exit 0), advance to push stage; if fails, transition to `commit-fix` with error
12. `apps/web/src/views/git/GitFlowModal.tsx:180-189` — on failure, show output pane + FixChat component
13. `apps/web/src/hooks/useGitFlowViewModel.ts:199-242` — `startFix()` creates a conversation, adds system prompt describing the failure
14. `apps/web/src/hooks/useGitFlowViewModel.ts:224-237` — calls `task.start` with Sonnet 5 model and `buildFixPrompt()` including error output and HOOK_SCOPE_RULE
15. `apps/web/src/views/git/GitFlowModal.tsx:580-706` — FixChat renders messages from the fix task; user and AI converse
16. `apps/web/src/hooks/useGitFlowViewModel.ts:340-355` — user clicks Re-commit; `reRunAfterFix()` re-executes `runCommit()`
17. `apps/web/src/hooks/useGitFlowViewModel.ts:109-137` — on commit success, `runPush()` streams `git.pushRun` with optional flags
18. `apps/agent/src/git/git-ops.ts:133-146` — `pushRun()` validates flags, adds `-u origin branch` if branch doesn't track remote, spawns `git push`
19. `apps/web/src/hooks/useGitFlowViewModel.ts:123-129` — push success: check `afterPush` state; if `pr-ask`, go to PR step; if `done`, finish
20. `apps/web/src/hooks/useGitFlowViewModel.ts:264-281` — `beginPr()` loads remote branches and drafts PR title/body via Haiku
21. `apps/agent/src/git/ai-drafts.ts:104-127` — `generatePrDescription()` uses one-shot Haiku to draft from commits vs base branch
22. `apps/web/src/hooks/useGitFlowViewModel.ts:92-107` — `validatePr()` calls `git.checkConflicts` (dry merge-tree probe)
23. `apps/agent/src/git/git-ops.ts:467-487` — `checkConflicts()` spawns `git merge-tree` to detect conflicts without modifying working tree
24. `apps/web/src/hooks/useGitFlowViewModel.ts:101-102` — if conflicts exist, transition to `pr-conflicts` stage
25. `apps/web/src/hooks/useGitFlowViewModel.ts:310-331` — `resolveConflicts()` fetches base branch and calls `git merge`; if conflicts, transition to `conflict-fix` stage
26. `apps/web/src/hooks/useGitFlowViewModel.ts:283-308` — if no conflicts, `createPrNow()` streams `git.createPr`
27. `apps/agent/src/git/git-ops.ts:177-220` — `createPr()` writes PR body to temp file, spawns `gh pr create --repo origin`
28. `apps/web/src/hooks/useGitFlowViewModel.ts:292-293` — on PR success, extract URL and transition to `done` stage
29. `apps/web/src/views/git/GitFlowModal.tsx:465-497` — DoneStage renders success message with PR link or fallback compare URL

## Files

- `apps/web/src/views/git/GitFlowModal.tsx` — render the wizard UI: header, stage body (confirm, branch, commit, push, PR), output pane, fix chat
- `apps/web/src/views/git/GitFlowHost.tsx` — mount point for the modal at shell level so it can be raised from anywhere
- `apps/web/src/views/git/GitPanel.tsx` — git panel commit message box and Commit button that triggers `startFlow()`
- `apps/web/src/hooks/useGitFlowViewModel.ts` — orchestrate all flow stages: start, branch, commit, push, PR validation, fix chat, re-runs
- `apps/web/src/state/git-flow.store.ts` — Zustand store: flow state (stage, output, branch name, PR metadata, error, fix conversation ID)
- `apps/agent/src/git/register-git-handlers.ts` — RPC handlers for all git flow methods: flowInfo, suggestBranchName, commitRun, pushRun, createPr, etc.
- `apps/agent/src/git/git-ops.ts` — spawn and stream git/gh commands with hooks, validate merge-tree output, manage temp files for PR body
- `apps/agent/src/git/git-service.ts` — manage active checkout, read status, refresh state after operations
- `apps/agent/src/git/ai-drafts.ts` — one-shot Haiku drafts for branch names, PR title/body, commit messages
- `apps/agent/src/hooks/git-flow-guard.ts` — hook that blocks agent attempts to commit/push/PR and publishes `git.flow.requested` event
- `apps/agent/src/hooks/git-flow-intent.ts` — detect commit/push/PR from tool calls (git tool or run_terminal command)
- `apps/agent/src/runtime.ts` — register GitFlowGuard as a preTool hook with matcher "git|run_terminal"
- `apps/web/src/services/event-dispatcher.ts` — route `git.flow.requested` event from agent to `useGitFlowStore.requestFlow()`
- `packages/protocol/src/methods/git.ts` — RPC method schemas: git.flowInfo, git.commitRun, git.pushRun, git.createPr, git.checkConflicts, git.mergeRun, git.generatePrDescription, git.suggestBranchName, git.remoteBranches, git.checkout
- `packages/protocol/src/models/git.ts` — types: GitFlowInfo, GitFlowRequest, GitFlowOperation, GitOpResult
- `packages/protocol/src/models/conversation.ts` — ChatMessage, ChatRole types for fix chat transcript
- `packages/protocol/src/events.ts` — `git.flow.requested` event schema and `git.status.updated` for live branch/file count
- `apps/agent/src/orchestrator/trivial-chat.ts` — detect light prompts to route fix chat to low-effort model tier

## Contracts

### RPC Methods

**git.flowInfo** → `{info: GitFlowInfo}` where `GitFlowInfo = {repo: string, branch: string, defaultBranch: string, hasCommits: boolean, hasUpstream: boolean, hasRemote: boolean}`. Workspace-relative repo path, current branch, default branch, flags for bootstrap logic.

**git.suggestBranchName** → `{name: string}`. Haiku drafts a feature branch name from staged changes.

**git.commitRun** `{message: string, stageAll?: boolean}` → `{result: GitOpResult}`. Optionally stages all files, commits with hooks. GitOpResult = `{ok: boolean, exitCode: number, output: string}`.

**git.pushRun** `{flags: string[]}` → `{result: GitOpResult}`. Validates flags (regex `^-{1,2}[A-Za-z0-9][\w=./:@^~,-]*$`, denies --exec, --receive-pack, --upload-pack), adds `-u origin branch` if needed, pushes.

**git.checkConflicts** `{base: string}` → `{mergeable: boolean, conflicts: string[]}`. Dry merge-tree probe; does not modify working tree.

**git.mergeRun** `{base: string}` → `{result: GitOpResult}`. Fetches origin/base, merges with --no-edit; conflicted exit is expected for conflict-fix loop.

**git.createPr** `{base: string, title: string, body: string}` → `{result: GitOpResult}` where `result.url` on success, `result.fallbackUrl` (compare page) on gh auth failure.

**git.generatePrDescription** `{base: string}` → `{title: string, body: string}`. Haiku drafts PR title and body from commits.

**git.remoteBranches** → `{branches: string[]}`. List of remote branch names for the PR base selector.

**git.checkout** `{ref: string, create?: boolean}` → `{}`. Switch or create branch.

### State

**GitFlowStore** (Zustand):
- `open: boolean` — modal is visible
- `stage: FlowStage` — current stage (idle, confirm, branch, commit, commit-fix, push, push-fix, pr-ask, pr-describe, pr-conflicts, conflict-fix, pr-create, pr-fix, done)
- `running: boolean` — a command is in flight
- `output: string` — accumulated stderr/stdout from git/gh
- `error: string | null` — current error message
- `info: GitFlowInfo | null` — repo state at flow start
- `request: GitFlowRequest | null` — agent's blocked operation (on confirm stage)
- `commitMessage: string` — pre-filled or edited by user
- `stageAllFirst: boolean` — stage all files on first commit
- `branchName: string` — feature branch name
- `fixConversationId: string | null` — conversation ID for embedded fix chat
- `prBase: string` — target branch for PR (e.g., "main")
- `prTitle: string` — PR title (editable)
- `prBody: string` — PR description (editable)
- `prUrl: string | null` — created PR URL (on done stage)
- `prCompareUrl: string | null` — github.com compare page fallback (if gh auth fails)

### External Calls

- `git add -A` — stage all changes (if stageAll flag set)
- `git commit -m "..."` — commit with hooks (pre-commit, commit-msg, etc.) executing
- `git push [-u origin branch] [flags]` — push to origin with optional user-supplied flags
- `git fetch origin <base> && git merge --no-edit origin/<base>` — probe/resolve merge conflicts
- `git merge-tree` — dry merge probe without modifying working tree
- `gh pr create --repo origin --title "..." --body <tmpfile>` — create PR, read URL from stdout
- Claude Haiku one-shot for branch name, PR title/body drafts (via runOneShot API)
- Sonnet 5 fix task (via task.start RPC) to edit files when git operations fail

### Events

- `git.flow.requested` — agent blocked from running git; payload: `{operation: "commit"|"push"|"pr", command: string, commitMessage?: string, reason: string}`
- `git.status.updated` — live branch and file count (for status bar badge)

## Edge cases

**No Remote**: Modal opens to done stage with error "Connect a GitHub remote first." User must cancel and set up GitHub.

**First Commit Ever** (no commits in repo): Skip PR step entirely (nothing to compare against), set `afterPush: "done"`, push with `-u origin` to create default branch.

**On Default Branch**: Suggest a feature branch name; user can edit or skip to commit on the current branch.

**Nothing Staged**: First commit stages all files (stageAll=true); later commits/merges re-stage all after AI fixes.

**Commit Hooks Fail**: Transition to commit-fix stage. Prompt shows failed hook output (tail-capped to 8000 chars). AI is given HOOK_SCOPE_RULE: fix DEFECTS in staged code (lint errors, failing tests), CREATE missing artifacts (tests, snapshots), do NOT refactor already-staged code. After fix, user clicks Re-commit to re-run hooks.

**Push Rejected**: Transition to push-fix stage. Output shows remote rejection. AI edits code and commits the fix.

**Merge Conflicts**: git merge-tree detects conflicts before modifying working tree. If conflicts exist, user can click "Resolve" to merge for real (expected to conflict). Transition to conflict-fix stage. AI edits conflicted files, user clicks "Commit merge & continue" to re-commit and re-validate PR.

**PR Creation Fails** (gh auth, SSO, org policy): prCompareUrl is populated with github.com compare page. User can open it manually and create PR by hand. Modal shows link.

**Cancelled Fix**: User clicks stop button. Agent finishes in-flight step, modal stays open on fix stage. User can click Re-commit to retry or close modal.

**Multi-Repo Workspace**: Fix prompt scopes AI to the specific checkout that failed (`scopeRoots: [repo]`). AI is told "workspace holds other checkouts, edit ONLY inside `./path/to/repo/`."

**Conflicting Flow**: User already has an open flow. Late block from agent does not reset it (requestFlow checks `s.open`).

**Push Flag Injection**: Free-form flags are shape-validated (regex) and matched against denylist (--exec, --receive-pack, --upload-pack). Invalid flags reject on the push screen with error "flag not allowed"; user stays on push stage to edit.

**Windows Command Line Cap**: PR body bypasses --body flag (32kb cap on Windows) by writing to temp file; gh reads from file.

**ANSI Escape Codes**: Output is stripped of CSI (colors/cursor) and OSC (title/link) sequences before display. Hooks can still run and see colors.

**GIT_TERMINAL_PROMPT=0**: Git commands fail fast on interactive credential prompts instead of hanging.

