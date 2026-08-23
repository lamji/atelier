# A silent provider stream must not hang the turn forever

Status: implemented (agent), 2026-08-19. Reported from a live session that
sat on "Working / working" indefinitely after a hook refused a `write_file`,
with the remaining plan steps at "0 tools · 0 edits".

## What was wrong

Nothing anywhere on the Claude stream path had a timeout. `grep -n
"setTimeout" src/orchestrator/pipeline-executor.ts` returned nothing.

Every other bound in the pipeline needs a **message to arrive** to work:

- `maxTurns` bounds rounds, and rounds are counted from result messages.
- The loop harness stall limits count rounds that made no progress.
- The completion gate runs at Stop, which is a message.
- `ctx.abort` is checked *inside* the `for await` body.

So a stream that simply stops saying anything — a wedged CLI subprocess, a
dropped connection, a tool call that never returns — parks the `for await`
forever. No timeout fires, no event is published, the task is never
released, and `ProcessCard` keeps rendering "Working" because that is the
last status it was given. The only exit is killing the app.

The user-visible cost is worse than the hang: a genuine stall is
indistinguishable from a slow turn, so it can never be reported precisely,
reproduced, or told apart from a long build.

## What changed

`StreamStallWatch` (`pipeline-executor.ts`) wraps the message loop.
`beat()` on every message re-arms it, so a chatty stream never trips.

- At `warnMs` (default 3m of total silence) it publishes `agent.status`
  with the silence duration, so the UI stops claiming progress it has no
  evidence for. A later message clears the warning.
- At `abortMs` (default 15m) it reports the abandonment, aborts `ctx.abort`,
  and marks the run `abandoned`; the turn's text gets a line saying the
  report above it is partial.

Limits come from `streamStallLimits()` — `ATELIER_STREAM_WARN_MS` and
`ATELIER_STREAM_ABORT_MS`, where `0` means never. Defaults are deliberately
generous: a long build or test run is legitimately quiet, and the warning
(not the abort) is what makes such a wait legible.

The abandonment detail is published **before** the abort, because aborting
may end the turn down the cancel path — where that detail is the only thing
separating "the user stopped it" from "it stopped answering".

## What this does NOT claim

It is not established that a stalled stream is what produced the reported
screenshot. There are no logs by default (`trace.ts` is opt-in via
`ATELIER_TRACE`), so the specific hang was not reproduced or traced. Two
other candidates were checked and cleared:

- **The rewrite guard is not looping.** `TargetedEditGuard` remembers the
  refusal per `(taskId, path)` and lets the repeat through, exactly as its
  message promises.
- **The DB approval wait is not it.** `awaitAnswer` already settles on a
  deadline and on abort.

What this change guarantees is narrower and worth having on its own: this
class of hang can no longer be silent. The next occurrence ends by itself
and says how long it was quiet before it did.

Verified: `pnpm --filter @atelier/agent smoke:loop-harness` — 31 checks,
including the limits, that a beating stream never trips, that a warning
alone does not cut the turn, that output clears a warning, and that
sustained silence aborts and reports.
