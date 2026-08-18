# Merge conflicts: detect → surface → resolve → finish

Status: implemented (agent + web), 2026-08-18.

## The goals

1. A conflict is **noticed automatically** — whether it came from Pull in
   Atelier or from `git pull` in a terminal — and it is unmistakable in the
   git panel, the file explorer and the dock.
2. Resolving is **one flow with two speeds**: hand-resolve a file in a real
   merge editor, or hand any subset of files (or all of them) to the AI and
   review what it did before completing.

## The flow

```
  Sync row ─── Pull (merge | rebase | ff-only) ── streamed output drawer
                    │
                    ├─ ok ─────────────────────────► done (drawer shows result)
                    │
                    └─ conflicts ──► MERGE MODE
                                     │
      .git watcher (terminal pull) ──┘   ← same entry, same UI
                                     │
      ┌──────────────────────────────┴──────────────────────────────┐
      │ Merge banner   "origin/main → feature"  ▓▓▓░░ 2/5 resolved   │
      │   [✦ Resolve all with AI]  [Abort]        (Commit merge when 0 left)
      │ Conflicts section  ! a.ts   Ours · Theirs · ✦      ✓ b.ts  AI·review · ↶
      └─────────────────────────────────────────────────────────────┘
                 │ click file                          │ AI ends
                 ▼                                     ▼
      Conflict Resolver (Monaco)              scan markers → stage clean
        lens: Accept Current | Incoming | Both   files → "AI · review" tag
        Alt+↑/↓ · compare ours↔theirs · autosave
        [Mark resolved]  → stages, jumps to next file
                 │
                 ▼  all resolved
      [Commit merge] / [Continue rebase]  → streamed → back to normal
```

Explorer: conflicted rows are red with a pulsing `!`, folders turn red up
to the root, the header grows a red **N conflicts · resolve →** pill that
jumps to the git view, and clicking a conflicted file opens the resolver in
the editor pane instead of the read-only viewer. Dock: the Changes tile
badge turns red and shows the conflict count. Anywhere else: a top-centre
alert pill ("3 merge conflicts · merge paused — Resolve") appears the first
time the count grows while the git view is off screen.

## Detection

- `GitStatus` gained `conflicts: string[]` (git's own unmerged list — every
  shape, `UU`/`AA`/`DD`/`AU`/…, not a guess from status letters) and
  `mergeState: { kind, ours, theirs, message }` read from `.git`
  (`MERGE_HEAD`, `rebase-merge/`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`).
- The `.git` watcher now also watches those files, and `git.state.changed`
  carries `conflicts` + `mergeKind`, so the dock/alert react before the panel
  refetches. A conflict made by any tool shows within the 400 ms debounce.
- Rebase labels are honest about git's swapped sides: ours = "onto",
  theirs = "<branch> (your commit)". The AI prompt repeats this.

## Resolution semantics (what each action does in git)

| UI                     | git                                                        |
| ---------------------- | ---------------------------------------------------------- |
| edits in the resolver  | autosaved to the working tree (conflict stays open)        |
| Mark resolved          | write + `git add` (this is what "resolved" means to git)   |
| Ours / Theirs (row)    | `checkout --ours/--theirs` + `add`; a side that does not exist in the index (delete/add conflicts) is `git rm` |
| Restore conflict (↶)   | `checkout -m` — markers come back, path is unmerged again  |
| Resolve with AI        | Sonnet task confined to the checkout; edits only. On end, files left marker-free are staged and tagged "AI · review" |
| Commit merge           | `git commit -m <edited MERGE_MSG>` (or `--no-edit`)        |
| Continue rebase/…      | `git <kind> --continue` with `GIT_EDITOR=:`                |
| Abort                  | `git <kind> --abort`                                       |

Pull always names its strategy (`--no-rebase` / `--rebase` / `--ff-only`):
a bare `git pull` on a diverged branch fails on modern git until
`pull.rebase` is set, and the panel must not depend on a config the user
never touched.

## Pickers and alerts (added same day)

- **Pull / Checkout open a picker** (`views/git/GitSyncModal.tsx`):
  remote + branch (filterable, defaults to the tracked upstream), pull
  strategy, checkout of local or remote branches (remote ones create a
  tracking branch). In the checkout picker the selected row doubles as the
  **base**: typing a name turns the action into "Branch out <name> from
  <selected>" (`git checkout -b <name> <base>`, plus `--no-track` when the
  base is a remote ref so the new branch does not adopt someone else's
  upstream). There is no Push button: pushing is the commit → push → PR
  wizard's job (hooks, AI fix loop, PR).
  Running flips the modal to a **terminal pane** streaming the real
  command (stdout+stderr interleaved, `$` prompt line, live cursor), then a
  one-line verdict and the next action (Done / Back / Resolve conflicts).
  Backed by `git.refs` (local ref store, no network), `git.pullRun`
  `{remote,branch}`, `git.checkoutRun` `{ref,create,track,from}`.
- **Every git operation raises an alert** (`state/alerts.store.ts`,
  `views/shell/AlertHost.tsx`): success and failure, one line each; the
  merge-conflict announcement is a sticky alert in the same stack. This is
  a standing rule for new git operations.

## Where things live

- protocol: `packages/protocol/src/models/git.ts` (`GitMergeState`,
  `GitConflictFile`, `GitPullMode`), `methods/git.ts` (`git.fetch`,
  `git.pullRun`, `git.conflictFile`, `git.resolveConflict`,
  `git.resolveConflictWith`, `git.restoreConflict`, `git.scanConflictMarkers`,
  `git.mergeAbort`, `git.mergeContinueRun`), `events.ts`.
- agent: `git/git-service.ts` (`readMergeState`, stage helpers, watcher),
  `git/git-ops.ts` (sync + conflict ops), `git/register-git-handlers.ts`.
  Smoke: `pnpm --filter @atelier/agent smoke:merge` builds a bare origin +
  two clones and drives the whole flow, including rebase and abort.
- web: `lib/conflict-markers.ts` (parser, diff3-aware), `state/git-merge.store.ts`,
  `hooks/useMergeConflictViewModel.ts` (+ shell effects), `views/git/SyncBar.tsx`,
  `MergeBanner.tsx`, `ConflictResolver.tsx`, `MergeConflictHost.tsx`;
  wiring in `GitPanel.tsx`, `RightDock.tsx`, `FileTreePanel.tsx`,
  `useFileExplorerViewModel.ts`, `dock/dock-items.ts`, `AppShell.tsx`.
