# Question turns: answer them, and remember what you answered

Status: implemented (agent), 2026-08-18. Reported from a live session where
a follow-up question re-derived an answer the assistant had just given, and
a turn that only asked something was free to edit the workspace.

## What was wrong

**1. A question could edit.** `readIntent` already classifies "what do you
mean by this?" as `kind: "question"`, and `isReadOnly(intent)` was used for
exactly two things (`pipeline-executor.ts`): skip `requirePlan`, and set
`mustEdit = false`. `ANSWER_ONLY_RULES` told the model in prose not to
change anything. Nothing enforced it — and because the plan-before-edit
gate is deliberately off for an answer, a question turn was the *least*
supervised turn in the app: it could edit, and it could edit without a
published plan.

**2. A follow-up could not rely on its own last answer.** Every Atelier
turn runs in a fresh provider session by design (`orchestrator.ts`:
`sdkSessionId: null` — "cross-task continuity is Atelier-owned context, not
a provider-native session id"). The only carrier is the recall block, which
budgets *all* prior turns into ~540 tokens and clips each from the middle
(`shared-session-context.ts`). Ask "what do you mean by this?" about a long
report and the model receives a fifth of its own words with the substance
cut out — so it searches the repo again to answer honestly. The user sees
the app forget what it said a minute ago.

`goAheadBlock` had already solved this shape for approvals ("ok", "do it"),
quoting the previous message verbatim; a question about that message did
not match its trigger.

## What changed

| | |
| --- | --- |
| `hooks/answer-only-guard.ts` | New built-in preTool hook. Refuses `write_file` / `replace_code` / `replace_many` while the task is marked answer-only, with a reason telling the model to say what it *would* change. |
| `orchestrator/plan-tracker.ts` | `markAnswerOnly(taskId)` / `isAnswerOnly(taskId)`, cleared with the rest of the task's policy in `clear()`. |
| `runtime.ts` | Registers the guard beside the plan-edit one (matcher `write_file\|replace_code\|replace_many`). |
| `orchestrator/pipeline-executor.ts` | Marks the task on a question turn; adds `followUpBlock`, an "asked-about" context section. |

The guard sits at `ToolRegistry.run`, so it holds for **every** provider —
Claude through MCP, Ollama through its own loop — rather than for whichever
one the fix was written against. Reading, searching, `git` and
`run_terminal` stay open: "why does this fail?" is a question that needs to
look around.

`followUpBlock` quotes the previous answer whole (4,000 chars; head+tail
with a marker beyond that) and **only** when all three hold: the turn is a
question, it carries a back-reference ("this", "that", "you said", "your
last report"), and there is a previous answer to quote. A new subject, a
change request, or a go-ahead pays nothing and keeps the ordinary flow.
The session model is untouched — still one fresh session per turn.

## Deliberately not done

- **No session resume across turns.** Provider-neutral continuity is the
  design; this only stops the one case where the clipping lost the thing
  being asked about.
- **No "Ask" mode in the composer.** A question still runs the full
  pipeline (`isTrivialChat` excludes anything ending in "?"), so a
  clarification costs a retrieval pass. That is a UI change and its own
  piece of work.

## Trade-off

A request phrased as a question ("how about adding a test?") is classified
as a question and will be answered rather than done. `CHANGE_REQUEST_OPENERS`
already catches the common polite forms ("can you center the login?" → work),
and the reply says what it would change, so "do it" is one turn away. The
guard is a listed built-in hook, so it can also be switched off in the
Hooks panel.

Verified: `pnpm --filter @atelier/agent smoke:answer-only` — 29 checks
covering intent classification, the guard's block/allow surface, per-task
isolation and release, and every trigger and non-trigger of the follow-up
block.
