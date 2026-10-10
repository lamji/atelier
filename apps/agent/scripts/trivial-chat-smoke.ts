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
  asksForPlanOnly,
  investigationTargets,
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

check(
  "pipeline reuses supplied evidence before opening a knowledge gap",
  FAST_RULES.startsWith("REUSE PROVIDED EVIDENCE FIRST") &&
    FAST_RULES.indexOf("REUSE PROVIDED EVIDENCE FIRST") <
      FAST_RULES.indexOf("KNOWLEDGE GAPS") &&
    FAST_RULES.includes("selected skill's read/study step")
);
check(
  "current-turn files are the scripted investigation entry points",
  JSON.stringify(
    investigationTargets(
      ["src/login-route.ts"],
      ["src/stale-session-file.ts"],
      ["src/unrelated.ts", "src/login-service.ts"]
    )
  ) === JSON.stringify(["src/login-route.ts"])
);
check(
  "a vague follow-up inherits the session entry point",
  JSON.stringify(
    investigationTargets(
      [],
      ["src/login-service.ts"],
      ["src/unrelated.ts"]
    )
  ) === JSON.stringify(["src/login-service.ts"])
);
check(
  "retrieval supplies entry points when the turn has no file anchor",
  JSON.stringify(
    investigationTargets(
      [],
      [],
      ["src/login-route.ts", "src/login-service.ts"]
    )
  ) === JSON.stringify(["src/login-route.ts", "src/login-service.ts"])
);
check(
  "scripted investigation targets are concrete, unique and bounded",
  investigationTargets(
    [],
    [],
    [
      "src/a.ts",
      "not-a-file",
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
      "src/e.ts",
      "src/f.ts",
      "src/g.ts",
    ]
  ).join(",") ===
    "src/a.ts,src/b.ts,src/c.ts,src/d.ts,src/e.ts,src/f.ts"
);

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
  "Plan mode reuses assembled code instead of reopening it",
  pipelineSource.includes("Use current code already carried in the assembled context") &&
    pipelineSource.includes("do not reopen code the prompt already provides") &&
    !pipelineSource.includes("Read the code you are about to change before you plan it")
);
check(
  "a question turn is not given the timeline contract",
  pipelineSource.includes(
    "if (answerOnly) this.deps.planTracker.markAnswerOnly(ctx.taskId);"
  ) &&
    pipelineSource.includes("else this.deps.planTracker.requirePlan(ctx.taskId);")
);

const retrievalStart = pipelineSource.indexOf(
  'const retrieval = await this.stage(ctx, "retrieve"'
);
const impactStart = pipelineSource.indexOf(
  "const radius = this.investigationRadius(ctx, intent);"
);
const executionStart = pipelineSource.indexOf(
  'const exec = await this.stage(ctx, "execute"'
);
check(
  "the executable investigation order is entry point, impact, then provider",
  retrievalStart >= 0 &&
    impactStart > retrievalStart &&
    executionStart > impactStart
);
check(
  "read-only investigations receive the impact returned by the graph walk",
  pipelineSource.includes(
    "private investigationRadius(ctx: TaskContext, intent: Intent)"
  ) &&
    !pipelineSource.includes(
      "if (isReadOnly(intent)) return emptyRadius([]);"
    ) &&
    pipelineSource.includes("retrieval,\n          radius,\n          plan,")
);

// The other half of the same rule: a turn that owes no edit must not be
// held by the completion gate either, or it ends on "the gate is still
// open" after spending the whole stall budget on work that never existed.
check(
  "an informational turn is not held by the completion gate",
  // The human half of the prompt, never the hidden preview block.
  pipelineSource.includes("!looksInformational(ctx.humanPrompt)")
);

// Ollama must receive the exact same assembled contract as Claude. Otherwise
// the skill/external-reference exception can pass the rule checks above yet
// disappear only when the selected provider is Ollama.
check(
  "Ollama receives the provider-neutral execution contract",
  pipelineSource.includes("system: providerContext") &&
    ollamaSource.includes("system: opts.system")
);

/**
 * Plan-only routing: a turn that asks for a PLAN owes no edit and no step
 * per request bullet. The first row is verbatim from the run where six
 * study steps ended with none checked. "plan" as a thing to build stays a
 * change request.
 */
const PLAN_ONLY: Array<[string, boolean]> = [
  [
    "Understand and study this and create a plan allocation rules should " +
      "be reflected in the dashboard and cost analysis",
    true,
  ],
  ["create an implementation plan for the new billing page", true],
  ["give me a plan first, don't implement yet", true],
  ["plan only: how would you migrate the auth module?", true],
  ["create a plan page under settings", false],
  ["add a plan selector to the pricing card", false],
  ["fix the terminal search", false],
  ["create a plan and then implement it", false],
];
for (const [prompt, want] of PLAN_ONLY) {
  const got = asksForPlanOnly(prompt);
  check(`plan-only ${JSON.stringify(prompt.slice(0, 50))}`, got === want, `got=${got}`);
}

console.log(failed === 0 ? "\nall cases pass" : `\n${failed} mismatch(es)`);
process.exit(failed === 0 ? 0 : 1);
