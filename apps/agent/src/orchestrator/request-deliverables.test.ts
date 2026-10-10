import assert from "node:assert/strict";
import { EventBus } from "../events/event-bus.js";
import type { ToolImpl, ToolRegistry } from "../tools/registry.js";
import { registerPlanTools } from "../tools/plan-tools.js";
import { PlanTracker } from "./plan-tracker.js";
import {
  extractDeliverables,
  uncoveredDeliverables,
} from "./request-deliverables.js";
import { turnStance } from "./turn-stance.js";

/**
 * The request as the user typed it on 2026-08-29 (conv_01M16GK2JABPQ1JC3B31).
 * The turn planned three steps — rewrite a prompt string, extend its
 * test, run the checks — and reported the whole design as delivered.
 */
const SPEC = [
  "here what i need, tree sitter, in app rag and in app mcp",
  "- tree sitter will be use to index the code repo",
  "-- this will trigger in app load",
  "-- it has a watcher to keep tree sitter updated",
  "-- it has an mcp with rag to retrive file tree needed only for task",
  "-- ex: fix the login button",
  "---- prmpts -> rag query from tree sitter -> the return tree will be " +
    "send to llm for context gathering -> ai understand first[add hooks " +
    "to make sure ai understand it or done reading all the files needed " +
    "to get the e2e login] -> ai run radius impact using tree sitter[to " +
    "avoide regression bugs, the only goal is for ai to undertsand the " +
    "afffected flow of the incoming edit] -> edt ->verify",
].join("\n");

/** The plan that turn actually set. */
const NARROW_PLAN = {
  goal:
    "Enhance Claude's Atelier workflow contract so it uses the live " +
    "Tree-sitter/RAG MCP context, completes end-to-end reading, runs " +
    "structural impact analysis before edits, and verifies changes.",
  steps: [
    {
      title: "Update the Claude system-prompt seam",
      files: ["src/vs/platform/agentHost/node/claude/claudeSdkOptions.ts"],
    },
    { title: "Extend the buildOptions contract test" },
    { title: "Run the narrowest compile/test checks" },
  ],
};

function toolCtx(taskId: string) {
  return {
    taskId,
    signal: new AbortController().signal,
    emitOutput: () => {},
  };
}

async function main(): Promise<void> {
  // ---- extraction -------------------------------------------------------
  const items = extractDeliverables(SPEC);
  assert.ok(
    items.some((item) => /index the code repo/.test(item)),
    `indexer is a deliverable: ${items.join(" | ")}`
  );
  assert.ok(items.some((item) => /watcher/.test(item)), "watcher");
  assert.ok(items.some((item) => /mcp with rag/.test(item)), "mcp+rag");
  assert.ok(
    items.some((item) => /radius impact/.test(item)),
    "an arrow-chain stage is its own deliverable"
  );
  assert.ok(
    !items.some((item) => /login button/.test(item)),
    "an example line is not a deliverable"
  );
  assert.ok(
    !items.some((item) => /regression/.test(item)),
    "a bracketed aside is stripped from its item"
  );
  assert.deepEqual(
    extractDeliverables("fix the label on the save button"),
    [],
    "a one-line request lists nothing, so nothing is checked"
  );

  // ---- coverage ---------------------------------------------------------
  const narrowText = [
    NARROW_PLAN.goal,
    ...NARROW_PLAN.steps.map((step) => step.title),
  ].join("\n");
  const gaps = uncoveredDeliverables(items, narrowText);
  assert.ok(
    gaps.some((item) => /watcher/.test(item)),
    `the prompt-only plan leaves the watcher uncovered: ${gaps.join(" | ")}`
  );
  assert.ok(gaps.some((item) => /index the code repo/.test(item)));
  assert.ok(gaps.some((item) => /app load/.test(item)));
  assert.ok(
    !gaps.some((item) => /radius impact/.test(item)),
    "a step that names impact analysis covers the impact item"
  );
  const namesEverything =
    `${narrowText}\nindexer over the code repo, triggered on app load, ` +
    "a watcher that keeps it updated, an mcp tool with rag retrieving " +
    "the file tree for the task, prompts to a rag query, the returned " +
    "tree sent to the llm for context gathering, the ai understands " +
    "first, radius impact, edit, verify";
  assert.deepEqual(
    uncoveredDeliverables(items, namesEverything),
    [],
    "naming every item's own words covers it"
  );

  // ---- set_plan is held to the request ---------------------------------
  const bus = new EventBus();
  const tracker = new PlanTracker(bus);
  const tools = new Map<string, ToolImpl>();
  const registry = {
    register: (name: string, impl: ToolImpl) => void tools.set(name, impl),
  } as unknown as ToolRegistry;
  registerPlanTools(registry, tracker);
  const setPlan = tools.get("set_plan");
  assert.ok(setPlan);

  tracker.bindTask("conv", "task-narrow", SPEC);
  tracker.requirePlan("task-narrow");
  const refused = (await setPlan(NARROW_PLAN, toolCtx("task-narrow"))) as {
    ok: boolean;
    error?: string;
    uncovered?: string[];
  };
  assert.equal(refused.ok, false, "the narrowed plan is refused");
  assert.match(refused.error ?? "", /no step of this plan delivers/);
  assert.match(refused.error ?? "", /notCovered/);
  assert.ok((refused.uncovered ?? []).length >= 2);
  assert.equal(tracker.get("task-narrow"), undefined, "nothing was adopted");

  // Declaring the gap is the honest exit — and it is recorded.
  const declared = (await setPlan(
    {
      ...NARROW_PLAN,
      notCovered: [
        "tree sitter index of the code repo on app load — no indexer exists yet",
        "file watcher to keep the index updated — depends on the indexer",
        "mcp with rag retrieving the task file tree, and the rag query it answers — depends on the indexer",
        "hooks gating that the ai understands first / has read the e2e flow, llm context gathering — prompt-only this turn",
      ],
    },
    toolCtx("task-narrow")
  )) as { ok: boolean; mode?: string; notCovered?: string[] };
  assert.equal(declared.ok, true, "a declared narrowing is accepted");
  assert.equal(declared.mode, "created");
  assert.equal(declared.notCovered?.length, 4);
  assert.equal(tracker.notCoveredFor("task-narrow").length, 4);
  assert.equal(tracker.get("task-narrow")?.notCovered?.length, 4);
  // …and a declaration that skips an item is still refused: "rag query"
  // and "understand first" name work of their own.
  tracker.clear("task-narrow");
  tracker.bindTask("conv", "task-partial", SPEC);
  tracker.requirePlan("task-partial");
  const partial = (await setPlan(
    { ...NARROW_PLAN, notCovered: ["indexer, watcher, mcp — later"] },
    toolCtx("task-partial")
  )) as { ok: boolean; uncovered?: string[] };
  assert.equal(partial.ok, false, "a partial declaration is refused");
  assert.ok((partial.uncovered ?? []).some((item) => /understand first/.test(item)));
  tracker.clear("task-partial");
  tracker.clear("task-narrow");

  // A plan that takes every item on passes without declaring anything.
  tracker.bindTask("conv", "task-full", SPEC);
  tracker.requirePlan("task-full");
  const full = (await setPlan(
    {
      goal: "Tree-sitter index, watcher, MCP RAG retriever, gate hooks, impact radius",
      steps: [
        { title: "Build the tree sitter indexer that runs on app load" },
        { title: "Add the file watcher that keeps the tree sitter index updated" },
        {
          title: "Expose an mcp tool with rag that retrieves the file tree for the task",
          detail: "the prompt becomes the rag query against the index",
        },
        { title: "Send the returned tree to the llm for context gathering" },
        { title: "Add hooks so the ai reads every file of the e2e flow first" },
        { title: "Run radius impact with tree sitter before the edit, then verify" },
      ],
    },
    toolCtx("task-full")
  )) as { ok: boolean; notCovered?: string[] };
  assert.equal(full.ok, true, "a complete plan is adopted");
  assert.equal(full.notCovered, undefined);
  tracker.clear("task-full");

  // An answer-only turn owes no plan coverage.
  tracker.bindTask("conv", "task-answer", SPEC);
  tracker.markAnswerOnly("task-answer");
  assert.deepEqual(
    tracker.coverageGaps("task-answer", "Explain", [{ title: "Explain" }]),
    []
  );
  tracker.clear("task-answer");

  // ---- the spec is a fresh turn, not a correction ----------------------
  assert.equal(
    turnStance({ humanPrompt: SPEC, previousStatus: "completed" }).stance,
    "fresh",
    '"to avoid regression bugs" is a goal, not a complaint'
  );
  assert.equal(
    turnStance({ humanPrompt: "this is a regression", previousStatus: "completed" }).stance,
    "correct"
  );

  console.log("request-deliverables: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
