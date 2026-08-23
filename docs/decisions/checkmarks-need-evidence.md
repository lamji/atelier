# A green checkmark must be backed by something Atelier watched happen

Status: implemented (agent), 2026-08-19. Reported from a live Ollama session
(`ollama/gemma3:4b`) that ran 23 tool rounds, showed four plan steps green —
"Initialize Expo project", "Define Theme and Colors", "Implement Base
Components", "Build Dashboard Layout Shell", each reading **"N tools · 0
edits"** — and had changed nothing at all.

## What was wrong

**1. The zero-edit guard was opt-out, and the model held the switch.**

```ts
function implementationStepNeedsEdit(step: PlanStep): boolean {
  return step.files.length > 0 && IMPLEMENTATION_STEP.test(step.title);
}
```

Both inputs come from the model's own `set_plan` draft: it writes the title
and it supplies `files`. gemma3 shipped drafts with **no files at all**, so
`step.files.length > 0` was false and the guard never ran — on any step,
whatever it was called. The verb list was a second opt-out for anything the
model phrased as "Define …" or "Initialize …", neither of which was in it.

A rule the subject can turn off by how it words a sentence is not a guard.

**2. A checkmark counted as progress, so the loop had no bound.**

`completionGateMadeProgress` accepted `completedSteps` increasing as
evidence, and the gate loop resets `ctx.gateNudges = 0` on progress. A model
checking one more free step off an untouched workspace therefore reset the
stall counter **every round** — the stall limit could never be reached. That
is the 23 rounds. The stream watchdog in
[stalled-streams.md](./stalled-streams.md) does not catch this either: the
stream was never silent. It was busy doing nothing.

## What changed

`plan-tracker.ts` — `stepNeedsEdit(step, taskHasEdits)`, with the file list
no longer part of the decision:

- A step that **names a change** ("Implement base components") always owes an
  applied edit of its own. Nothing else evidences it.
- **Any other step** owes one only while the whole task has landed zero
  edits. That is the exact state this exists for, and it leaves a real
  "decide the theme" step free to close on a turn that is otherwise working.
- **Read/verify steps are exempt from both** — running the check *is* their
  work. `NON_EDIT_STEP` (read, review, inspect, verify, typecheck, run,
  lint, test, …) is the one wording that still opts out, and it opts out of
  a checkmark that claims nothing.

`pipeline-executor.ts` — `completionGateMadeProgress` no longer counts a
completed step. An applied edit and an observed verification are the two
things Atelier *watched happen*; a checkmark is the model's own assertion.

The guard lives in `PlanTracker.transitionStep`, so it holds for every
provider — Claude through MCP and Ollama through its own loop — not just the
one it was written against.

## Trade-off

The default is now "a step owes an edit" rather than "a step owes an edit if
it looks like one", so a genuinely non-edit step worded outside
`NON_EDIT_STEP` ("Decide on the theme") is refused on a turn that has
changed nothing. The model's route out is to do the work the plan promised;
if it truly cannot, the gate's `NO CHANGE NEEDED:` exit
([gate-exits.md](./gate-exits.md)) ends the turn honestly. The cost of the
opposite default is on the screenshot: four green checkmarks over an empty
workspace.

`smoke:plan`'s fixture needed one added `noteFileEdited` for its first step —
its bare-noun titles ("types", "symbol") now need evidence like anything
else. That is the rule working, not the test bending.

Verified: `smoke:plan` (93 checks, including both reported Ollama escapes —
the file-bearing one and the fileless one — plus the verify-step exemption),
`smoke:claude-budget`, `smoke:loop-harness`, `smoke:answer-only`,
`smoke:trivial-chat`, and `tsc --noEmit`.
