import {
  CLAUDE_FAST_BUILTINS,
  CLAUDE_TURN_LIMIT_CONTINUATIONS,
  claudeContinuationBudget,
  claudeEffort,
  claudeTurnBudget,
  isTurnLimitError,
  tolerateTurnLimit,
} from "../src/orchestrator/claude-budget.js";
import { completionGateMadeProgress } from "../src/orchestrator/pipeline-executor.js";

/** The exact text the SDK rethrows when the CLI spends its ceiling. */
const TURN_LIMIT_ERROR = new Error(
  "Claude Code returned an error result: Reached maximum number of turns (12)"
);

/** Yields each value, then fails the way a real session fails. */
async function* failingAfter<T>(values: T[], error: unknown): AsyncGenerator<T> {
  for (const value of values) yield value;
  throw error;
}

async function drain<T>(
  stream: AsyncIterable<T>,
  onLimit: () => void
): Promise<T[]> {
  const seen: T[] = [];
  for await (const value of tolerateTurnLimit(stream, onLimit)) seen.push(value);
  return seen;
}

let limitSeen = 0;
const delivered = await drain(
  failingAfter(["a", "b", "c"], TURN_LIMIT_ERROR),
  () => {
    limitSeen += 1;
  }
);

// Nothing else may be swallowed: an auth failure or a crashed subprocess
// still has to reach the orchestrator's error path.
const other = new Error("Claude Code process exited with code 1");
let otherPropagated = false;
try {
  await drain(failingAfter(["a"], other), () => undefined);
} catch (error) {
  otherPropagated = error === other;
}

// A large change often patches one file several times. Unique-file count
// remains flat, but each applied edit must earn the next bounded chunk.
const progressBefore = {
  completedSteps: 1,
  changedFiles: 2,
  appliedEdits: 3,
  verificationObserved: false,
};
const sameFileEditProgress = { ...progressBefore, appliedEdits: 4 };

const checks: Array<[string, boolean]> = [
  ["native Task fan-out is disabled", !CLAUDE_FAST_BUILTINS.includes("Task" as never)],
  ["Grep remains available", CLAUDE_FAST_BUILTINS.includes("Grep")],
  ["Glob remains available", CLAUDE_FAST_BUILTINS.includes("Glob")],
  ["execute is bounded", claudeTurnBudget("execute") === 12],
  ["review is tightly bounded", claudeTurnBudget("review") === 4],
  ["repair is bounded", claudeTurnBudget("fix") === 6],
  ["default effort is low", claudeEffort(undefined) === "low"],
  ["explicit high effort survives", claudeEffort("high") === "high"],
  ["the SDK's turn-limit error is recognised", isTurnLimitError(TURN_LIMIT_ERROR)],
  ["an unrelated error is not", !isTurnLimitError(other)],
  ["a spent ceiling keeps every message", delivered.join("") === "abc"],
  ["a spent ceiling does not throw", limitSeen === 1],
  ["every other error still propagates", otherPropagated],
  [
    "an execute continuation gets a full session, not a wrap-up",
    claudeContinuationBudget("execute") === claudeTurnBudget("execute"),
  ],
  [
    "unstarted or not, the execute continuation is the same size",
    claudeContinuationBudget("execute", true) ===
      claudeContinuationBudget("execute"),
  ],
  [
    "review and repair continuations stay short",
    claudeContinuationBudget("review") < claudeTurnBudget("execute") &&
      claudeContinuationBudget("review", true) ===
        claudeContinuationBudget("review"),
  ],
  [
    "continuations are bounded by consecutive stalls, not a total",
    CLAUDE_TURN_LIMIT_CONTINUATIONS >= 3,
  ],
  [
    "another edit to the same file earns another completion-gate chunk",
    sameFileEditProgress.changedFiles === progressBefore.changedFiles &&
      completionGateMadeProgress(progressBefore, sameFileEditProgress),
  ],
  [
    "unchanged completion evidence remains a bounded stall",
    !completionGateMadeProgress(progressBefore, { ...progressBefore }),
  ],
];

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
}
if (failed > 0) process.exit(1);
