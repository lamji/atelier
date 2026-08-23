# The knowledge turn was losing to the turn without it

Status: implemented (agent), 2026-08-20. Reported from live use: the same
tasks came out better with the composer's "System knowledge" box **un**ticked
than with it on. That is the whole product claim inverted — the pipeline is
supposed to be what a stock CLI turn is not — so the three places it was
spending the model's attention were measured rather than defended.

## What was wrong

**1. The impact gate charged per file and delivered nothing.**
`ImpactFirstGuard` refused the first write to every existing source file
until the model had called `impact_of_edit` for that exact path: a blocked
tool call plus a round-trip, per file, on every change task. What it bought
was a `SymbolGraph` walk against SQLite — single-digit milliseconds, no model
involved, data the server could have handed over for free.

Meanwhile `pipeline-executor.ts` fed the prompt `emptyRadius([])` and had
done since the gate was introduced, so `buildImpactContext` rendered nothing
on every turn. The turn paid the tax and got none of the information: no
callers, no downstream flows, no tests at risk, no anchored lessons. Direct
mode skipped the whole arrangement, which is part of why it felt faster.

**2. The directory map stopped one level above every answer.** It was
directories-only at depth 3. On a monorepo the budget went to
`apps/`, `apps/web/`, `apps/web/src/` and ran out — exactly above
`src/views/<area>/`, where a guessed path goes wrong. No file names at all,
so "which file owns the editor pane?" was still a guess, or a `list_dir`
round-trip per folder. And `scopeContext` returned `""` when the session had
no scope lock, so the turns with the *least* idea where anything lives got no
map whatsoever.

**3. `FAST_RULES` had grown back into the block it replaced.** 5.4 KB
(~1,350 tokens) on every turn, against direct mode's ~1.9 KB. Roughly half of
it was advice about how to think — SIMPLEST FIX, GROUND BEFORE EDITING,
VERIFY BEFORE CLAIMING, a paragraph of timeline procedure — competing with
the task and with each other for attention. `SYSTEM_RULES` sat beside it,
another 7.3 KB, exported and imported by nothing.

## What changed

- **The radius is computed, not demanded.** `PipelineExecutor.editRadius`
  runs `ImpactAnalyzer.analyze` over this turn's targets (the paths the user
  named; failing that, the working set retrieval re-earned, capped at
  `IMPACT_TARGETS`) and hands the result to the assembler, which already knew
  how to render it. Callers, flows, tests and lessons now arrive *before* the
  model picks a target, for zero round-trips. `impact_of_edit` stays on the
  tool surface for symbol- and line-precise questions the block cannot
  answer. Question turns skip the walk.
- **The gate is gone**, along with `hooks/impact-guard.ts` and its smoke.
  `runtime.ts` calls `hooks.delete(LEGACY_IMPACT_HOOK_ID)` rather than
  disabling it: the stored config says action `block`, and a built-in hook
  whose guard is not registered falls through to its stored action — leaving
  the row would have refused *every* write on an existing install.
- **The map lists files.** `renderProjectTree` walks to depth 5 against a
  character budget (~7 KB) instead of a line count, names up to ten files per
  directory with a `+N` remainder, and includes the root's own manifests.
  `apps/web/` renders in ~715 tokens with every real path in it. An unlocked
  turn now gets the workspace root at a smaller budget and shallower depth
  (`UNSCOPED_MAX_CHARS`, `UNSCOPED_MAX_DEPTH`) — breadth until a lock says
  which project matters.
- **The rules are ~800 tokens.** Every clause that names a hook still has one
  behind it (targeted edits, flex layout, git flow, DB approval, the
  completion hook that reads the plan); the advice-shaped clauses went.
  `SYSTEM_RULES` was deleted outright.

## What this does not change

The other code guards stand. Targeted-edit, flex-layout and modularity still
block, still stand down for direct tasks, and are still stated in the rules.
The consent gates (git flow, database, dev server) were never part of this.

`direct-mode-smoke` now demonstrates the guard bypass on the targeted-edit
guard, since the guard it used to use no longer exists.
