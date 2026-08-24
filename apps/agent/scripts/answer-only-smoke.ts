/**
 * Answer-only smoke: a turn the user asked as a QUESTION must answer, not
 * edit — and a follow-up asking about the previous answer must arrive with
 * that answer attached instead of re-deriving it from the repo.
 *
 *   pnpm --filter @atelier/agent smoke:answer-only
 */
import type { HookConfig } from "@atelier/protocol";
import { EventBus } from "../src/events/event-bus.js";
import { PlanTracker } from "../src/orchestrator/plan-tracker.js";
import {
  AnswerOnlyGuard,
  ANSWER_ONLY_HOOK_ID,
  ANSWER_ONLY_HOOK_NAME,
} from "../src/hooks/answer-only-guard.js";
import { followUpBlock, readIntent } from "../src/orchestrator/pipeline-executor.js";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  const suffix = detail === undefined ? "" : ` — ${String(detail)}`;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${suffix}`);
  if (!ok) failures += 1;
}

const REPORT =
  "G1 — a closed capped month was recomputed and overwritten. " +
  "x".repeat(6_000) +
  "\nResidual: the freeze still lags the cap by up to one worker interval.";

const priorTurns = [
  { role: "user" as const, text: "check the capped-month behaviour" },
  { role: "assistant" as const, text: REPORT },
];

// ── intent: what counts as a question ──────────────────────────────────
const QUESTIONS = [
  "what do you mean by this? and sample scenario?",
  "why is the residual harmless?",
  "how does the freeze interact with Redis?",
  "how should I fix the requests pane?",
  "is there a better way to redesign the listing?",
  "find the component preview entry point",
  "explain that last paragraph",
  // The bare confirmations that used to classify as work: no opener word,
  // just a question mark. Each one cost a full change turn.
  "so its the same?",
  "so its the same right?",
  "please answer it is the same?",
  "ok and this one?",
];
const WORK = [
  "fix the residual lag",
  "can you center the login?",
  "add a test for the freeze",
  "implement it",
  // A solution request is implementation work even though it opens with
  // "find"; keep the original typo because that is what reached production.
  "find a way to supprt this",
  "find a way to support multiple previews",
  // Still work: filler in front of a change verb, and a change verb that
  // arrives too late for the openers to see it.
  "so fix the residual lag",
  "the login is broken, can you center it?",
  // A question may lead into an imperative. The imperative wins because the
  // autonomous timeline must implement it in this same turn.
  "is there a better way of listing? not a traditional but unique listing. redesign it with a better ui ux",
  "Do antyhtnng to redesign this and after that fix what was in the image",
  "review this, then fix it",
];
for (const prompt of QUESTIONS) {
  check(`question: "${prompt.slice(0, 34)}…"`, readIntent(prompt).kind === "question");
}
for (const prompt of WORK) {
  check(`work: "${prompt.slice(0, 34)}"`, readIntent(prompt).kind === "work");
}

// ── the guard refuses edits on a question turn ─────────────────────────
const bus = new EventBus();
const blocked: unknown[] = [];
bus.subscribe((e) => {
  if (e.topic === "hook.blocked") blocked.push(e.payload);
});
const plans = new PlanTracker(bus);
const guard = new AnswerOnlyGuard(plans, bus);
/** The hook the engine would hand the guard for these tools. */
const HOOK: HookConfig = {
  id: ANSWER_ONLY_HOOK_ID,
  name: ANSWER_ONLY_HOOK_NAME,
  enabled: true,
  event: "preTool",
  matcher: "write_file|replace_code|replace_many",
  action: "block",
};

const run = (taskId: string, toolName: string) =>
  guard.check({
    toolName,
    input: {},
    taskId,
    hook: HOOK,
    signal: new AbortController().signal,
  });

check("edit allowed before the turn is marked", (await run("t1", "write_file")) === undefined);

plans.markAnswerOnly("t1");
for (const tool of ["write_file", "replace_code", "replace_many"]) {
  const decision = await run("t1", tool);
  check(`${tool} is refused on a question turn`, decision?.allowed === false);
}
check("the refusal says what to do instead", /answer it in prose/i.test(String((await run("t1", "write_file"))?.reason)));
check("the block is announced to the UI", blocked.length > 0);

for (const tool of ["read_file", "search_text", "run_terminal", "git"]) {
  check(`${tool} still allowed — an answer needs to look`, (await run("t1", tool)) === undefined);
}
check("another task is unaffected", (await run("t2", "write_file")) === undefined);

plans.clear("t1");
check("clearing the task releases the block", (await run("t1", "write_file")) === undefined);

// ── the referenced answer travels with the follow-up ───────────────────
const question = readIntent("what do you mean by this? and sample scenario?");
const block = followUpBlock("what do you mean by this? and sample scenario?", priorTurns, question);
check("a back-referencing question carries the answer", block.includes("YOUR PREVIOUS ANSWER"));
check("the head of the answer survives", block.includes("G1 — a closed capped month"));
check("the tail — where the caveat lives — survives", block.includes("Residual: the freeze still lags"));
check("an over-long answer is marked, not silently cut", block.includes("[middle omitted]"));
check("it tells the model the words are its own", /your own message/i.test(block));

const noReference = followUpBlock(
  "what does the precompute worker interval default to?",
  priorTurns,
  readIntent("what does the precompute worker interval default to?")
);
check("a question about something else pays nothing", noReference === "");

// "its" is the contraction the back-reference used to miss, so the shortest
// follow-up of all arrived without the answer it was asking about.
const itsBlock = followUpBlock(
  "so its the same?",
  priorTurns,
  readIntent("so its the same?")
);
check("\"so its the same?\" carries the answer", itsBlock.includes("YOUR PREVIOUS ANSWER"));

const workTurn = "fix that residual lag";
check(
  "a change request is left to the ordinary flow",
  followUpBlock(workTurn, priorTurns, readIntent(workTurn)) === ""
);

const goAhead = "go ahead";
check(
  "a go-ahead keeps its own block",
  followUpBlock(goAhead, priorTurns, readIntent(goAhead)) === ""
);

const firstTurn = followUpBlock(
  "what do you mean by this?",
  [{ role: "user" as const, text: "hello" }],
  readIntent("what do you mean by this?")
);
check("nothing to quote, nothing added", firstTurn === "");

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
