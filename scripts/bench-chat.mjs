// Where a chat turn spends its time, read back from the latency trace.
//
// The process rail shows you one run. This shows you the shape across many:
// which stage is actually slow, how long the model takes to say its first
// word, and whether a change to the prompt or the pipeline moved either.
//
// Record a session:
//
//   # PowerShell
//   $env:ATELIER_TRACE = "$PWD\.atelier-data\chat-trace.jsonl"; pnpm dev
//
//   # bash / zsh
//   ATELIER_TRACE="$PWD/.atelier-data/chat-trace.jsonl" pnpm dev
//
// Send a few messages, then:
//
//   node scripts/bench-chat.mjs
//   node scripts/bench-chat.mjs .atelier-data/before.jsonl   # compare a file
//
// Nothing is written unless ATELIER_TRACE is set, so this costs a normal
// run nothing at all.
import fs from "node:fs";
import path from "node:path";

const DEFAULT_TRACE = path.join(".atelier-data", "chat-trace.jsonl");

/** Pipeline order, so the report reads the way the turn ran. */
const STAGE_ORDER = [
  "understand",
  "retrieve",
  "plan",
  "hooks",
  "execute",
  "validate",
  "knowledge",
  "review",
  "summary",
];

/** Everything before `execute` is pure overhead in front of the answer. */
const PRE_EXECUTE = STAGE_ORDER.slice(0, STAGE_ORDER.indexOf("execute"));

function readEvents(file) {
  if (!fs.existsSync(file)) {
    console.error(`No trace at ${file}\n`);
    console.error("Record one first:");
    console.error(
      '  $env:ATELIER_TRACE = "$PWD\\.atelier-data\\chat-trace.jsonl"; pnpm dev'
    );
    console.error('  ATELIER_TRACE="$PWD/.atelier-data/chat-trace.jsonl" pnpm dev');
    process.exit(1);
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        // A half-written last line is normal while a run is still going.
        return [];
      }
    });
}

/** One entry per task, in the order the tasks started. */
function groupByTask(events) {
  const tasks = new Map();
  for (const event of events) {
    let task = tasks.get(event.taskId);
    if (!task) {
      task = { taskId: event.taskId, stages: new Map(), firstToken: null };
      tasks.set(event.taskId, task);
    }
    if (event.kind === "stage") {
      // A stage can run more than once per task (validation repair rounds
      // re-enter execute); charge the task for all of it.
      task.stages.set(event.stage, (task.stages.get(event.stage) ?? 0) + event.ms);
    }
    // The first one is the answer; later ones are repair and review rounds.
    if (event.kind === "first_token" && task.firstToken === null) {
      task.firstToken = event.ms;
    }
  }
  return [...tasks.values()];
}

/**
 * Time the user spends looking at nothing: the stages that run in front of
 * the model call, plus the model's own time to its first word. It does NOT
 * include context assembly inside `execute`, which is not traced separately
 * — so this is a floor, not the whole wait.
 */
function timeToFirstToken(task) {
  if (task.firstToken === null) return null;
  const before = PRE_EXECUTE.reduce(
    (total, stage) => total + (task.stages.get(stage) ?? 0),
    0
  );
  return before + task.firstToken;
}

/** Nearest-rank, so a two-sample p50 is the lower of the pair, not the max. */
function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function secs(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function row(cells, widths) {
  return cells.map((cell, i) => String(cell).padEnd(widths[i])).join("  ").trimEnd();
}

function reportStages(tasks) {
  const widths = [12, 9, 9, 9, 7];
  console.log(row(["stage", "p50", "p95", "max", "runs"], widths));
  console.log("-".repeat(widths.reduce((a, b) => a + b + 2, 0)));
  for (const stage of STAGE_ORDER) {
    const values = tasks
      .map((task) => task.stages.get(stage))
      .filter((ms) => ms !== undefined);
    if (values.length === 0) continue;
    console.log(
      row(
        [
          stage,
          secs(percentile(values, 50)),
          secs(percentile(values, 95)),
          secs(Math.max(...values)),
          values.length,
        ],
        widths
      )
    );
  }
}

function reportHeadline(tasks) {
  const ttfts = tasks.map(timeToFirstToken).filter((ms) => ms !== null);
  const totals = tasks.map((task) =>
    [...task.stages.values()].reduce((a, b) => a + b, 0)
  );
  console.log(`tasks traced        ${tasks.length}`);
  if (ttfts.length > 0) {
    console.log(
      `time to first token p50 ${secs(percentile(ttfts, 50))}   ` +
        `p95 ${secs(percentile(ttfts, 95))}`
    );
  }
  if (totals.length > 0) {
    console.log(
      `whole turn          p50 ${secs(percentile(totals, 50))}   ` +
        `p95 ${secs(percentile(totals, 95))}`
    );
  }
  console.log("");
}

const file = process.argv[2] ?? DEFAULT_TRACE;
const tasks = groupByTask(readEvents(file));

if (tasks.length === 0) {
  console.error(`${file} has no task events yet — send a message first.`);
  process.exit(1);
}

console.log(`\n${file}\n`);
reportHeadline(tasks);
reportStages(tasks);
console.log(
  "\ntime to first token = the stages before execute, plus the model's own\n" +
    "first word. Context assembly inside execute is not traced, so treat it\n" +
    "as a floor.\n"
);
