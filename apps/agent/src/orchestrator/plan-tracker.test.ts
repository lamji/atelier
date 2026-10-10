import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { EventBus } from "../events/event-bus.js";
import type { ToolImpl, ToolRegistry } from "../tools/registry.js";
import { registerPlanTools } from "../tools/plan-tools.js";
import { PlanCheckpointStore } from "./plan-checkpoint-store.js";
import { PlanTracker, UNVERIFIED_MARK } from "./plan-tracker.js";

const TASK = "task-plan-tracker";

/** The one update_plan_step call a refusal must spell out. */
const NEXT_CALL = /Exact next call: update_plan_step\(stepId: "step[^"]+", status: "[a-z-]+"\)/;

/**
 * The failure this covers was watched happening: update_plan_step came back
 * `{ ok: false, error: "Unknown step id for this task" }`, the model could
 * not tell what a valid id WAS, and it burned 61 tool calls on one step
 * re-guessing and re-calling set_plan (which appends) to find out.
 */
async function main(): Promise<void> {
  const bus = new EventBus();
  const tracker = new PlanTracker(bus);

  const plan = tracker.adopt(TASK, "Add the helper", [
    { title: "Add snapshot-invalidation helper", files: ["src/routes/contracts.ts"] },
    { title: "Call it on every contract mutation", files: ["src/routes/contracts.ts"] },
  ]);
  const [first, second] = plan.steps;
  assert.ok(first && second);
  assert.match(first.id, /^step/, "ids are minted, not guessable");

  // A bad reference no longer dead-ends: it names every step and the one
  // the timeline is on, so the next call can be right.
  const bogus = tracker.transitionStep(TASK, "step_nonexistent", "in-progress");
  assert.equal(bogus.ok, false);
  assert.equal(bogus.steps?.length, 2, "the whole timeline comes back");
  assert.equal(bogus.currentStepId, first.id, "and which one it is waiting on");
  assert.match(bogus.error ?? "", /Add snapshot-invalidation helper/);

  // The title is a step's visible identity, so it resolves.
  assert.equal(
    tracker.transitionStep(TASK, "Add snapshot-invalidation helper", "in-progress").ok,
    true,
    "an exact title works where the id was lost"
  );

  // An omitted reference can only mean the step being waited on.
  tracker.noteFileEdited(TASK, "src/routes/contracts.ts");
  assert.equal(
    tracker.transitionStep(TASK, "", "done").ok,
    true,
    "no id means the current step"
  );
  assert.equal(tracker.get(TASK)?.steps[0]?.status, "done");

  // Order is still enforced — leniency never skips a step.
  const skipped = tracker.transitionStep(TASK, first.id, "done");
  assert.equal(skipped.ok, true, "re-checking a done step is a no-op, not an error");

  // Three consecutive rejections change the wording: stop looping, here is
  // the exact call, or report BLOCKED.
  let last = tracker.transitionStep(TASK, "nope", "done");
  assert.equal(last.ok, false);
  assert.ok(!/failure 3 in a row/.test(last.error ?? ""), "not yet");
  last = tracker.transitionStep(TASK, "nope", "done");
  last = tracker.transitionStep(TASK, "nope", "done");
  assert.match(last.error ?? "", /failure 3 in a row/);
  assert.match(last.error ?? "", /set_plan APPENDS/);
  assert.match(last.error ?? "", /BLOCKED:/);
  assert.match(
    last.error ?? "",
    new RegExp(second.id),
    "and names the exact call to make instead"
  );

  // A transition that lands clears the streak.
  assert.equal(tracker.transitionStep(TASK, second.id, "in-progress").ok, true);
  const afterProgress = tracker.transitionStep(TASK, "nope", "done");
  assert.ok(
    !/in a row/.test(afterProgress.error ?? ""),
    "progress resets the loop counter"
  );

  // A git-ref-only task: real work, zero applied edits. Before this it
  // could never check a step off, so the gate stayed open and the turn
  // reported BLOCKED over bookkeeping.
  const refTask = "task-git-refs";
  const refPlan = tracker.adopt(refTask, "Clean the branch", [
    { title: "Reset SPDNX-Dev to origin" },
  ]);
  const refStep = refPlan.steps[0];
  assert.ok(refStep);
  assert.equal(tracker.transitionStep(refTask, refStep.id, "in-progress").ok, true);
  const noEffect = tracker.transitionStep(refTask, refStep.id, "done");
  assert.equal(noEffect.ok, false, "nothing observed yet, so no checkmark");
  assert.match(noEffect.error ?? "", /0 applied edits/);

  tracker.noteWorkObserved(refTask);
  assert.equal(
    tracker.transitionStep(refTask, refStep.id, "done").ok,
    true,
    "a command that ran clean is effect, even with no file diff"
  );

  // It only ever credits a step that was actually started.
  const unstarted = "task-unstarted";
  const unstartedPlan = tracker.adopt(unstarted, "Do a thing", [
    { title: "Add the helper" },
  ]);
  tracker.noteWorkObserved(unstarted);
  const pendingStep = unstartedPlan.steps[0];
  assert.ok(pendingStep);
  assert.equal(
    tracker.transitionStep(unstarted, pendingStep.id, "done").ok,
    false,
    "a pending step earns nothing from an unrelated command"
  );

  // No plan at all is still a clean, non-throwing refusal.
  const orphan = tracker.transitionStep("task-with-no-plan", "", "done");
  assert.equal(orphan.ok, false);
  assert.equal(orphan.steps, undefined);

  // C2: every refusal that has a current step spells out the one call the
  // timeline would accept next — a rule without the call is what looped.
  assert.match(bogus.error ?? "", NEXT_CALL);
  assert.match(noEffect.error ?? "", NEXT_CALL);
  assert.match(
    noEffect.error ?? "",
    new RegExp(`stepId: "${refStep.id}", status: "done"`),
    "a started step's next call is done, not in-progress again"
  );
  assert.match(
    last.error ?? "",
    /mark it skipped with a note saying why/,
    "the escalation names the retarget route"
  );
  assert.match(last.error ?? "", /then set_plan the correct step/);

  // C1: a step aimed at the wrong file can be skipped before it starts,
  // but only with the reason on record; the timeline then moves on.
  const skipTask = "task-skip";
  const skipPlan = tracker.adopt(skipTask, "Change the label", [
    { title: "Update the label in Header.tsx", files: ["src/Header.tsx"] },
    { title: "Update the label in Footer.tsx", files: ["src/Footer.tsx"] },
  ]);
  const [wrong, right] = skipPlan.steps;
  assert.ok(wrong && right);
  const bare = tracker.transitionStep(skipTask, wrong.id, "skipped");
  assert.equal(bare.ok, false, "skipping from pending needs a note");
  assert.match(bare.error ?? "", /note saying why/);
  assert.equal(
    tracker.transitionStep(skipTask, wrong.id, "skipped", "wrong file").ok,
    true,
    "a reasoned skip is accepted from pending"
  );
  assert.equal(tracker.get(skipTask)?.steps[0]?.status, "skipped");
  assert.deepEqual(
    tracker.unfinishedSteps(skipTask).map((step) => step.id),
    [right.id],
    "a skipped step no longer holds the completion gate"
  );
  assert.equal(
    tracker.transitionStep(skipTask, right.id, "in-progress").ok,
    true,
    "the next step becomes current"
  );
  assert.equal(
    tracker.transitionStep(skipTask, wrong.id, "skipped", "again").ok,
    true,
    "re-skipping a skipped step is a no-op, like re-checking a done one"
  );

  // C4: "done" is the model's word; verification is something observed.
  const events: Array<Record<string, unknown>> = [];
  bus.subscribe((event) => {
    if (event.topic === "plan.step.updated") {
      events.push(event.payload as Record<string, unknown>);
    }
  });
  const proofTask = "task-proof";
  const proofPlan = tracker.adopt(proofTask, "Two fixes", [
    { title: "Fix the null check", files: ["src/a.ts"] },
    { title: "Fix the off-by-one", files: ["src/b.ts"] },
    { title: "Run the tests" },
  ]);
  const [asserted, proven, runTests] = proofPlan.steps;
  assert.ok(asserted && proven && runTests);
  assert.equal(
    tracker.noteVerified(proofTask, "pnpm test exit 0"),
    false,
    "nothing in progress, nothing to credit"
  );
  tracker.transitionStep(proofTask, asserted.id, "in-progress");
  tracker.noteFileEdited(proofTask, "src/a.ts");
  assert.equal(tracker.transitionStep(proofTask, asserted.id, "done", "ok").ok, true);
  assert.equal(
    tracker.get(proofTask)?.steps[0]?.note,
    `ok ${UNVERIFIED_MARK}`,
    "an implementation step checked off without proof says so"
  );

  tracker.transitionStep(proofTask, proven.id, "in-progress");
  tracker.noteFileEdited(proofTask, "src/b.ts");
  assert.equal(tracker.noteVerified(proofTask, "pnpm typecheck exit 0"), true);
  const verifiedEvent = events.at(-1);
  assert.equal(verifiedEvent?.stepId, proven.id);
  assert.equal(verifiedEvent?.status, "in-progress");
  assert.equal(
    verifiedEvent?.verification,
    "pnpm typecheck exit 0",
    "plan.step.updated carries the verification"
  );
  assert.equal(tracker.transitionStep(proofTask, proven.id, "done").ok, true);
  assert.equal(tracker.get(proofTask)?.steps[1]?.note, undefined, "verified: no mark");
  assert.equal(
    events.at(-1)?.verification,
    "pnpm typecheck exit 0",
    "the done event still carries the proof, so the UI can draw it solid"
  );

  tracker.transitionStep(proofTask, runTests.id, "in-progress");
  tracker.noteWorkObserved(proofTask);
  assert.equal(tracker.transitionStep(proofTask, runTests.id, "done").ok, true);
  assert.equal(
    tracker.get(proofTask)?.steps[2]?.note,
    undefined,
    "a run/verify step is its own evidence; no mark"
  );

  planOnlyAndCancelledCases();
  await checkpointCases();
}

/**
 * C5: the run this covers (conv_01M2MBG2J1905XF76MRA, 2026-09-16) was
 * "understand and study this and create a plan" — six study steps and zero
 * edits by design. The first step could not be checked (no edit), so the
 * model cancelled it; every transition after that was refused with "finish
 * the current step first", naming the step it had just cancelled. The study
 * finished with nothing checked.
 */
function planOnlyAndCancelledCases(): void {
  const bus = new EventBus();
  const tracker = new PlanTracker(bus);

  // A cancelled step is behind the timeline, not in front of it.
  const wedge = "task-wedge";
  const wedged = tracker.adopt(wedge, "Study the flow", [
    { title: "Trace tag-filter propagation" },
    { title: "Trace allocation-rule matching" },
    { title: "Define the implementation" },
  ]);
  const [one, two, three] = wedged.steps;
  assert.ok(one && two && three);
  assert.equal(tracker.transitionStep(wedge, one.id, "in-progress").ok, true);
  assert.equal(
    tracker.transitionStep(wedge, one.id, "cancelled", "not this turn").ok,
    true
  );
  assert.equal(
    tracker.transitionStep(wedge, two.id, "in-progress").ok,
    true,
    "the step after a cancelled one is the current step"
  );
  const bogus = tracker.transitionStep(wedge, "nope", "done");
  assert.equal(bogus.currentStepId, two.id, "refusals point at it too");
  assert.equal(
    tracker.transitionStep(wedge, one.id, "cancelled").ok,
    true,
    "re-cancelling a cancelled step is a no-op"
  );
  assert.deepEqual(
    tracker.unfinishedSteps(wedge).map((step) => step.id),
    [one.id, two.id, three.id],
    "but it was not delivered, so the completion gate still lists it"
  );

  // A plan-only turn: every step is a study step, so the edit gate is not
  // the rule, and the request's bullets are the spec, not deliverables.
  const study = "task-study";
  tracker.bindTask(
    "conv-study",
    study,
    [
      "Understand and study this and create a plan:",
      "- For each resource, check whether a rule applies",
      "- If a rule exists, multiply the cost by its percentage",
    ].join("\n")
  );
  tracker.markPlanOnly(study);
  assert.deepEqual(
    tracker.coverageGaps(study, "Study the flow", [
      { title: "Trace the filter flow" },
    ]),
    [],
    "a plan-only turn owes no step per request bullet"
  );
  const studied = tracker.adopt(study, "Study the flow", [
    { title: "Trace the filter flow" },
    { title: "Define the implementation and its tests" },
  ]);
  const [trace, define] = studied.steps;
  assert.ok(trace && define);
  assert.equal(tracker.transitionStep(study, trace.id, "in-progress").ok, true);
  assert.equal(
    tracker.transitionStep(study, trace.id, "done", "labels flow through").ok,
    true,
    "a study step closes with no edit"
  );
  assert.equal(tracker.transitionStep(study, define.id, "in-progress").ok, true);
  assert.equal(tracker.transitionStep(study, define.id, "done").ok, true);
  assert.equal(
    tracker.get(study)?.steps[1]?.note,
    undefined,
    "a design step is not an unverified implementation claim"
  );
  tracker.clear(study);
  assert.equal(tracker.isPlanOnly(study), false, "cleared with the task");
}

/**
 * C3: the plan of a task the user STOPPED is remembered across tasks, and a
 * new set_plan that repeats one of its steps is warned before it starts.
 */
async function checkpointCases(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-plan-ckpt-"));
  const log = { warn() {} } as unknown as Logger;
  try {
    const bus = new EventBus();
    const store = new PlanCheckpointStore(root, log);
    const tracker = new PlanTracker(bus, store);
    const conv = "conv-1";

    assert.equal(store.lastCheckpoint(conv), null, "no checkpoint yet");
    assert.equal(tracker.previousPlan(conv), null);

    tracker.bindTask(conv, "task-a", "make the title red");
    const planA = tracker.adopt("task-a", "Red title", [
      { title: "Update the title colour in Header.tsx" },
      { title: "Run the tests" },
    ]);
    tracker.transitionStep("task-a", planA.steps[0]!.id, "in-progress");
    tracker.cancelPending("task-a");
    tracker.clear("task-a");

    const last = store.lastCheckpoint(conv);
    assert.equal(last?.taskId, "task-a");
    assert.equal(last?.request, "make the title red");
    assert.equal(last?.status, "cancelled", "any cancelled step marks the plan");

    await tick();
    tracker.bindTask(conv, "task-b", "still wrong, the title is not red");
    assert.equal(
      tracker.previousPlanFor("task-b")?.taskId,
      "task-a",
      "the new task sees the previous one's plan"
    );

    // The current task's own placeholder never counts as "previous".
    tracker.setPlan({
      id: "plan-b0",
      taskId: "task-b",
      goal: "placeholder",
      createdAt: Date.now() + 1,
      steps: [
        {
          id: "step-b0",
          title: "Update the title colour in Header.tsx",
          files: [],
          status: "pending",
        },
      ],
    });
    assert.equal(store.lastCheckpoint(conv)?.taskId, "task-b");
    assert.equal(store.lastCheckpoint(conv, "task-b")?.taskId, "task-a");
    // …and the user stops this one too, so it is the newest stopped plan.
    tracker.cancelPending("task-b");
    tracker.clear("task-b");

    // set_plan on the next task warns when it repeats a stopped step.
    const tools = new Map<string, ToolImpl>();
    const registry = {
      register: (name: string, impl: ToolImpl) => void tools.set(name, impl),
    } as unknown as ToolRegistry;
    registerPlanTools(registry, tracker);
    const setPlan = tools.get("set_plan");
    assert.ok(setPlan);
    await tick();
    tracker.bindTask(conv, "task-c", "still wrong");
    const ctx = {
      taskId: "task-c",
      signal: new AbortController().signal,
      emitOutput: () => {},
    };
    const repeated = (await setPlan(
      {
        goal: "Red title",
        steps: [{ title: "update the title colour in header.tsx" }],
      },
      ctx
    )) as { ok: boolean; mode: string; warning?: string };
    assert.equal(repeated.ok, true);
    assert.equal(repeated.mode, "created");
    assert.match(
      repeated.warning ?? "",
      /planned the same step "update the title colour in header.tsx" and the user stopped it/
    );
    assert.match(repeated.warning ?? "", /target the text\/element they named/);
    tracker.clear("task-c");

    // A different step, or a previous plan that finished, draws no warning.
    await tick();
    tracker.bindTask(conv, "task-d", "now the footer");
    const fresh = (await setPlan(
      { goal: "Footer", steps: [{ title: "Update the footer colour" }] },
      { ...ctx, taskId: "task-d" }
    )) as { warning?: string };
    assert.equal(fresh.warning, undefined);
    const planD = tracker.get("task-d")!;
    tracker.transitionStep("task-d", planD.steps[0]!.id, "in-progress");
    tracker.noteFileEdited("task-d", "src/Footer.tsx");
    tracker.transitionStep("task-d", planD.steps[0]!.id, "done");
    tracker.clear("task-d");
    assert.equal(store.lastCheckpoint(conv)?.status, "complete");

    await tick();
    tracker.bindTask(conv, "task-e", "footer again");
    const again = (await setPlan(
      { goal: "Footer", steps: [{ title: "Update the footer colour" }] },
      { ...ctx, taskId: "task-e" }
    )) as { warning?: string };
    assert.equal(again.warning, undefined, "a finished plan is not a stopped one");

    tracker.removeConversation(conv);
    assert.equal(store.lastCheckpoint(conv), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Checkpoints order by updatedAt; two saves in one ms would tie. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

void main();
