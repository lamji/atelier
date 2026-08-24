/**
 * What SHAPE a turn is, decided without a model call: small talk, a
 * question to be answered, or work to be done. Getting the middle one
 * wrong is expensive in both directions — a question answered with an
 * implementation, or a change request answered with prose.
 *
 *   pnpm --filter @atelier/agent smoke:trivial-chat
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isTrivialChat } from "../src/orchestrator/trivial-chat.js";
import {
  ANSWER_ONLY_RULES,
  FAST_RULES,
  readIntent,
} from "../src/orchestrator/pipeline-executor.js";
import { DIRECT_RULES } from "../src/orchestrator/direct-mode.js";

const CASES: Array<[string, boolean]> = [
  ["hi", true],
  ["thanks!", true],
  ["ok cool", true],
  ["nice one", true],
  ["good morning", true],
  ["so why i cant login? docker is running and etc", false],
  ["why you did not found it earlier?", false],
  ["fix the terminal search", false],
  ["build in 1.0.4", false],
  ["apps/web/src/App.tsx", false],
  ["run the tests", false],
  ["the other issue?", false],
];

let failed = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failed += 1;
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
}

for (const [prompt, want] of CASES) {
  const got = isTrivialChat(prompt, false);
  if (got !== want) {
    failed++;
    console.log(`MISMATCH ${JSON.stringify(prompt)} want=${want} got=${got}`);
  }
}

/**
 * Answer-only routing. The left column is verbatim from a session where
 * every one of these was answered with another round of edits instead of
 * an answer, which is what the question intent now prevents.
 */
const INTENT: Array<[string, "question" | "work"]> = [
  ["where did you put it?", "question"],
  ["are you really changing the right file?", "question"],
  ["what is your context?", "question"],
  ["did you follow the task?", "question"],
  ["explain the 422 middleware", "question"],
  ["show me where the resolver lives", "question"],
  ["how should I fix the requests pane?", "question"],
  ["is there a better way to redesign the listing?", "question"],
  // Imperative in form or in effect: these still owe a change. A question
  // mark is punctuation, not intent.
  ["fix the Spend by Region card", "work"],
  ["can you center the login?", "work"],
  ["remove the retry in tag coverage", "work"],
  ["apply that to all api", "work"],
  ["add the same approach to gke-kpi", "work"],
  [
    "is there a better way of listing? not a traditional but unique listing. redesign it with a better ui ux",
    "work",
  ],
  [
    "Do antyhtnng to redesign this and after that fix what was in the image",
    "work",
  ],
];

for (const [prompt, want] of INTENT) {
  const got = readIntent(prompt).kind;
  check(`${JSON.stringify(prompt)} -> ${want}`, got === want, got);
}

check(
  "the answer-only block forbids the timeline",
  ANSWER_ONLY_RULES.includes("set_plan") &&
    ANSWER_ONLY_RULES.includes("DO NOT IMPLEMENT")
);

for (const [name, rules] of [
  ["normal", FAST_RULES],
  ["direct", DIRECT_RULES],
] as const) {
  check(
    `${name} rules exempt skills and user-named external reads`,
    rules.includes("Installed skills are runtime instructions") &&
      rules.includes("authorized read-only reference") &&
      !rules.includes("Requests to work outside the workspace must be declined")
  );
}

// The block only helps if the pipeline actually withholds the execution
// contract from a question turn; requiring a plan is what makes the model
// open a checklist in the first place.
const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineSource = fs.readFileSync(
  path.join(here, "../src/orchestrator/pipeline-executor.ts"),
  "utf8"
);
const ollamaSource = fs.readFileSync(
  path.join(here, "../src/providers/ollama/agent-loop.ts"),
  "utf8"
);
check(
  "a question turn is not given the timeline contract",
  pipelineSource.includes(
    "if (answerOnly) this.deps.planTracker.markAnswerOnly(ctx.taskId);"
  ) &&
    pipelineSource.includes("else this.deps.planTracker.requirePlan(ctx.taskId);")
);

// The other half of the same rule: a turn that owes no edit must not be
// held by the completion gate either, or it ends on "the gate is still
// open" after spending the whole stall budget on work that never existed.
check(
  "an informational turn is not held by the completion gate",
  pipelineSource.includes("!looksInformational(ctx.prompt)")
);

// Ollama must receive the exact same assembled contract as Claude. Otherwise
// the skill/external-reference exception can pass the rule checks above yet
// disappear only when the selected provider is Ollama.
check(
  "Ollama receives the provider-neutral execution contract",
  pipelineSource.includes("system: providerContext") &&
    ollamaSource.includes("system: opts.system")
);

console.log(failed === 0 ? "\nall cases pass" : `\n${failed} mismatch(es)`);
process.exit(failed === 0 ? 0 : 1);
