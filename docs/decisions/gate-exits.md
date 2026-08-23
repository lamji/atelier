# The completion gate needs an exit for turns that owe no edit

Status: implemented (agent), 2026-08-19. Reported from a live session where
the user pasted a working `curl` against their dev API and said "that was
the dev" — and Atelier spent eight model calls before ending with "_The
completion gate is still open — plan steps remained unfinished_".

Follows [question-turns.md](./question-turns.md), which fixed the same
shape one classification earlier.

## What was wrong

**1. Both declared exits were unreachable.** `harnessPrompt` tells the model
that a `BLOCKED:` line is "the only report the gate accepts while items
remain open", and the gate item for a no-edit turn said "if the request
truly needs no code change, say why in one line". Neither could work. The
Claude Stop hook decides purely from `opts.completionGate()`, and a blocked
Stop **erases the report it blocked** (`text = ""`, then
`completionReportText` returns `""`). So the model wrote the exact sentence
the loop was looking for, the hook deleted it, the loop saw an empty round,
and `reportsHardBlocker(round)` tested a string that no longer contained
anything. The gate could not be talked out of, only outlasted — which is
why every one of these turns ended the same way: stall budget spent, scary
note appended.

**2. A statement classified as work.** `readIntent` splits prompts two ways,
question or work, on interrogative openers and a trailing `?`. "i will
prove you wrong `curl …` that was the dev" has neither, so it was `work` →
`actionable` → `mustEdit` → a gate whose `nothingImplemented` clause was
true and would stay true, because there was never anything to change.

## What changed

| | |
| --- | --- |
| `loop-harness.ts` | `reportsNoChangeNeeded()`, and a round prompt that names **both** exits and what each is for. |
| `pipeline-executor.ts` | `completionStopHookDecision` takes the candidate report and accepts a declared exit (`declaresHonestExit`). The Stop hook passes `text`. |
| `pipeline-executor.ts` | The gate loop skips outright when the first pass declared no change, and breaks with the gate **closed** when a round does. |
| `pipeline-executor.ts` | `looksInformational()`, subtracted from `actionable`. |
| `completionGatePrompt` | The no-edit item now names `NO CHANGE NEEDED:` as the thing that closes the gate. |

`BLOCKED:` still ends the turn with `GATE_BLOCKED_NOTE` — it is a real
unfinished task the user must unblock. `NO CHANGE NEEDED:` closes the gate
with no note at all: nothing is outstanding.

`looksInformational` is deliberately narrow. It requires a reporting opener
("i will…", "that was…", "here's…", "fyi", "it returned…") **and** no change
verb anywhere in the prompt, so "i just ran it and it 404s, fix the route"
is still work. Unlike a question it is **not** marked answer-only: the turn
keeps its full tool surface and may still edit if the information plainly
implies one. What it no longer does is *require* an edit.

## Trade-off

A model can now end a turn by writing `NO CHANGE NEEDED:`, which is an
escape hatch a lazy pass could reach for. Three things bound it: the line
is in the user's report where a wrong one is obvious, the prompt says
"never use it to defer work you could do", and it costs the same as the
`BLOCKED:` exit that has always been there. The alternative — no exit at
all — is what shipped, and it did not produce more work; it produced eight
calls of the same non-work plus a warning that the answer might be wrong.

Verified: `pnpm --filter @atelier/agent smoke:loop-harness` (24 checks,
covering both exits, the Stop-hook acceptance, and the informational
classifier's triggers and non-triggers) and `smoke:trivial-chat`.
`smoke:pipeline` and `smoke:hooks` need a free port / the Electron ABI and
were not run.
