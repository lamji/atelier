import {
  CLAUDE_FAST_BUILTINS,
  claudeEffort,
  claudeTurnBudget,
} from "../src/orchestrator/claude-budget.js";

const checks: Array<[string, boolean]> = [
  ["native Task fan-out is disabled", !CLAUDE_FAST_BUILTINS.includes("Task" as never)],
  ["Grep remains available", CLAUDE_FAST_BUILTINS.includes("Grep")],
  ["Glob remains available", CLAUDE_FAST_BUILTINS.includes("Glob")],
  ["execute is bounded", claudeTurnBudget("execute") === 12],
  ["review is tightly bounded", claudeTurnBudget("review") === 4],
  ["repair is bounded", claudeTurnBudget("fix") === 6],
  ["default effort is low", claudeEffort(undefined) === "low"],
  ["explicit high effort survives", claudeEffort("high") === "high"],
];

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
}
if (failed > 0) process.exit(1);
