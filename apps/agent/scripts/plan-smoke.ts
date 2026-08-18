/**
 * Strict execution-timeline smoke: ordered steps must be explicitly checked,
 * provider reports stay gated, and newly discovered work appends safely.
 *
 *   pnpm --filter @atelier/agent smoke:plan
 */
import { EventBus } from "../src/events/event-bus.js";
import { PlanTracker } from "../src/orchestrator/plan-tracker.js";
import { PlanCheckpointStore } from "../src/orchestrator/plan-checkpoint-store.js";
import {
  canRunNudge,
  completionGateMadeProgress,
  completionGatePrompt,
  completionGateRequired,
  completionGateResultText,
  completionReportText,
  completionStopHookDecision,
  COMPLETION_GATE_RETRIES,
  planFromMarkdown,
  turnLimitContinuationPrompt,
} from "../src/orchestrator/pipeline-executor.js";
import type { Plan } from "@atelier/protocol";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";

const TASK = "task-1";
const plan: Plan = {
  id: "plan-1",
  taskId: TASK,
  goal: "add transforms",
  createdAt: 0,
  steps: [
    { id: "s1", title: "types", detail: "", files: ["a/types.ts"], status: "pending" },
    { id: "s2", title: "symbol", detail: "", files: ["a/Symbol.tsx"], status: "pending" },
    { id: "s3", title: "handlers", detail: "", files: ["a/Canvas.tsx"], status: "pending" },
    { id: "s4", title: "controls", detail: "", files: ["a/Canvas.tsx"], status: "pending" },
    { id: "s5", title: "persist", detail: "", files: ["a/Modal.tsx", "a/types.ts"], status: "pending" },
  ],
};

function main(): void {
  const bus = new EventBus();
  const updates: Array<{ stepId: string; status: string }> = [];
  let planCreates = 0;
  bus.subscribe((e) => {
    if (e.topic === "plan.step.updated") {
      updates.push(e.payload as { stepId: string; status: string });
    }
    if (e.topic === "plan.created") planCreates += 1;
  });
  const tracker = new PlanTracker(bus);
  tracker.setPlan(plan);

  let fail = 0;
  const check = (name: string, ok: boolean, extra = "") => {
    if (!ok) fail += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  };
  const statusOf = (id: string) =>
    tracker.get(TASK)!.steps.find((s) => s.id === id)!.status;

  // An edit for a later step cannot manufacture completion or skip ahead.
  tracker.noteFileEdited(TASK, "a/Symbol.tsx");
  check("later edit does not check s1", statusOf("s1") === "pending", statusOf("s1"));
  check("later edit does not start s2", statusOf("s2") === "pending", statusOf("s2"));
  check(
    "pending step cannot jump straight to done",
    !tracker.transitionStep(TASK, "s1", "done").ok
  );
  check(
    "later step cannot start before current is done",
    !tracker.transitionStep(TASK, "s2", "in-progress").ok
  );

  // The reported Ollama escape: a model read Home.js, marked "Fix Header
  // Positioning" done, and never called an edit tool. A change-labelled step
  // with declared files must keep its checkmark locked until edit.applied.
  const zeroEditTask = "task-zero-edit";
  const zeroEditTracker = new PlanTracker(new EventBus());
  zeroEditTracker.setPlan({
    id: "plan-zero-edit",
    taskId: zeroEditTask,
    goal: "fix the header",
    createdAt: 0,
    steps: [
      {
        id: "fix-header",
        title: "Fix Header Positioning",
        files: ["src/screens/customer/Home.js"],
        status: "pending",
      },
    ],
  });
  check(
    "zero-edit implementation step starts",
    zeroEditTracker.transitionStep(zeroEditTask, "fix-header", "in-progress").ok
  );
  const zeroEditDone = zeroEditTracker.transitionStep(
    zeroEditTask,
    "fix-header",
    "done"
  );
  check(
    "zero-edit implementation step cannot manufacture a checkmark",
    !zeroEditDone.ok && (zeroEditDone.error ?? "").includes("0 applied edits"),
    zeroEditDone.error
  );
  zeroEditTracker.noteFileEdited(zeroEditTask, "src/screens/customer/Home.js");
  check(
    "real edit evidence unlocks the implementation checkmark",
    zeroEditTracker.transitionStep(zeroEditTask, "fix-header", "done").ok
  );

  check("s1 explicitly starts", tracker.transitionStep(TASK, "s1", "in-progress").ok);
  check("s1 explicitly checks done", tracker.transitionStep(TASK, "s1", "done").ok);

  // A matching real edit may start only the current step; done is explicit.
  tracker.noteFileEdited(TASK, "a/Symbol.tsx");
  check("s2 starts from its edit", statusOf("s2") === "in-progress", statusOf("s2"));
  check("s2 explicitly checks done", tracker.transitionStep(TASK, "s2", "done").ok);

  // Shared files still progress one ordered step at a time.
  tracker.noteFileEdited(TASK, "a/Canvas.tsx");
  check("s3 starts from shared file", statusOf("s3") === "in-progress", statusOf("s3"));
  check("s4 stays pending", statusOf("s4") === "pending", statusOf("s4"));
  check("s3 explicitly checks done", tracker.transitionStep(TASK, "s3", "done").ok);
  tracker.noteFileEdited(TASK, "a/Canvas.tsx");
  check("s4 starts only after s3 done", statusOf("s4") === "in-progress", statusOf("s4"));
  check("s4 explicitly checks done", tracker.transitionStep(TASK, "s4", "done").ok);

  // Path drift (leading ./ and case) still starts the current step.
  tracker.noteFileEdited(TASK, "./A/Modal.tsx");
  check("s5 in-progress via fuzzy path", statusOf("s5") === "in-progress");

  // Summary must not manufacture completion for work without evidence.
  check(
    "unfinished steps remain visible",
    tracker.unfinishedSteps(TASK).map((step) => step.id).join(",") === "s5",
    tracker.unfinishedSteps(TASK).map((step) => step.id).join(",")
  );
  check("events were published", updates.length > 0, `${updates.length} updates`);
  const gatePrompt = completionGatePrompt(tracker.unfinishedSteps(TASK), true);
  check("gate names exact open step", gatePrompt.includes("[in-progress] persist"));
  check("gate names missing verification", gatePrompt.includes("No successful verification"));
  check("empty evidence passes the gate", completionGatePrompt([], false) === "");
  const missingPlanGate = completionGatePrompt([], false, false, true);
  check("missing execution timeline fails the gate", missingPlanGate !== "");
  check("missing-plan gate tells the model to call set_plan", missingPlanGate.includes("set_plan"));

  // Only Claude implements the Plan checkbox as a read-only SDK mode. Ollama
  // must keep its completion gate because it returns before that SDK branch.
  check(
    "local Ollama stays guarded when Plan is enabled",
    completionGateRequired({
      actionable: true,
      planMode: true,
      model: "ollama-local/qwen2.5-coder:7b",
    })
  );
  check(
    "cloud Ollama stays guarded when Plan is enabled",
    completionGateRequired({
      actionable: true,
      planMode: true,
      model: "ollama/qwen3-coder:480b",
    })
  );
  check(
    "Claude interactive Plan remains a deliberate gate exemption",
    !completionGateRequired({
      actionable: true,
      planMode: true,
      model: "claude-sonnet-4-5",
    })
  );
  check(
    "ordinary change work remains guarded",
    completionGateRequired({
      actionable: true,
      planMode: false,
      model: "claude-sonnet-4-5",
    })
  );
  check(
    "read-only work does not acquire a completion gate",
    !completionGateRequired({
      actionable: false,
      planMode: false,
      model: "ollama-local/qwen2.5-coder:7b",
    })
  );

  // Non-done terminal labels are not an escape hatch. The current step can
  // be retried, but only an explicit done checkmark clears it.
  check("current step may record failure", tracker.transitionStep(TASK, "s5", "failed").ok);
  check("failed step remains unfinished", tracker.unfinishedSteps(TASK)[0]?.status === "failed");
  check(
    "failed step remains in the completion prompt",
    completionGatePrompt(tracker.unfinishedSteps(TASK), false).includes("[failed] persist")
  );
  check("failed step may restart", tracker.transitionStep(TASK, "s5", "in-progress").ok);
  check("current step may record skipped", tracker.transitionStep(TASK, "s5", "skipped").ok);
  check("skipped step remains unfinished", tracker.unfinishedSteps(TASK)[0]?.status === "skipped");
  check("skipped step may restart", tracker.transitionStep(TASK, "s5", "in-progress").ok);
  check("current step may record cancelled", tracker.transitionStep(TASK, "s5", "cancelled").ok);
  check("cancelled step remains unfinished", tracker.unfinishedSteps(TASK)[0]?.status === "cancelled");
  check("cancelled step may restart", tracker.transitionStep(TASK, "s5", "in-progress").ok);
  check("only done clears the last step", tracker.transitionStep(TASK, "s5", "done").ok);
  check("completed tracker has no unfinished steps", tracker.unfinishedSteps(TASK).length === 0);

  // Claude's Stop hook must refuse an early report with the exact live gate
  // reason. stop_hook_active says this is Claude's retry after a block; it
  // does not prove the work finished and must not bypass the same live gate.
  const blockedStop = completionStopHookDecision(gatePrompt, false);
  check("Stop hook blocks an early final report", blockedStop.decision === "block");
  check("Stop hook returns the live remaining work", blockedStop.reason === gatePrompt);
  check(
    "Stop hook allows a completed checklist",
    completionStopHookDecision("", false).decision === undefined
  );
  const activeRetry = completionStopHookDecision(gatePrompt, true);
  check("active Stop retry remains blocked while work is open", activeRetry.decision === "block");
  check("active Stop retry receives the same live work", activeRetry.reason === gatePrompt);
  check(
    "active Stop retry passes once evidence clears",
    completionStopHookDecision("", true).decision === undefined
  );
  check(
    "blocked Claude candidate is never renderable",
    completionReportText("premature report", false) === ""
  );
  check(
    "accepted Claude report is released",
    completionReportText("finished report", true) === "finished report"
  );
  const turnLimitNote =
    "\n\n_Atelier exhausted its bounded continuation budget while the live " +
    "completion gate was still open; the task is incomplete._";
  check(
    "intermediate ceiling notes disappear after successful completion",
    completionGateResultText(
      `finished report${turnLimitNote}${turnLimitNote}${turnLimitNote}`,
      false
    ) === "finished report"
  );
  const stalledReport = completionGateResultText(
    `partial report${turnLimitNote}${turnLimitNote}${turnLimitNote}`,
    true
  );
  check(
    "an open gate renders one verdict instead of repeated ceiling notes",
    !stalledReport.includes("bounded continuation budget") &&
      stalledReport.match(/The completion gate is still open/g)?.length === 1
  );

  // Repeated set_plan calls append discovered work without replacing any
  // existing id/status or allowing the original contract to shrink.
  const originalIds = tracker.get(TASK)!.steps.map((step) => step.id).join(",");
  const appended = tracker.extend(TASK, [
    { title: "newly discovered fix", files: ["a/new.ts"] },
  ]);
  check("new work appends to the live timeline", appended.length === 1);
  check(
    "existing timeline ids survive extension",
    tracker.get(TASK)!.steps.slice(0, 5).map((step) => step.id).join(",") === originalIds
  );
  check("appended work is pending", appended[0]?.status === "pending");
  check("extended plan is republished", planCreates === 1, String(planCreates));
  check(
    "duplicate extension cannot replace the plan",
    tracker.extend(TASK, [{ title: "newly discovered fix", files: ["a/new.ts"] }]).length === 0
  );
  check(
    "same visible step stays deduplicated when file metadata changes",
    tracker.extend(TASK, [{ title: " Newly Discovered Fix ", files: [] }]).length === 0
  );

  // A max-turn continuation must carry the live checklist and cannot grant
  // the exact report-only escape used by the reported failed run.
  const ceilingPrompt = turnLimitContinuationPrompt(gatePrompt, false);
  check("turn-limit continuation carries open work", ceilingPrompt.includes(gatePrompt));
  check(
    "turn-limit continuation forbids a partial report",
    ceilingPrompt.includes("not permission to report partial work")
  );
  check(
    "turn-limit continuation has no abandon-work escape",
    !ceilingPrompt.includes("make no further edits") &&
      !ceilingPrompt.includes("what is left")
  );

  // The failure the gate was blind to: a turn that registered no plan steps
  // and changed no file scored clean on both inputs, because touchesCode([])
  // is false. It has to fail on the third.
  const unstartedGate = completionGatePrompt([], false, true);
  check(
    "a change turn with zero edits fails before any continuation",
    unstartedGate !== ""
  );
  check(
    "the gate says which evidence is missing",
    unstartedGate.includes("Not one file was changed")
  );
  check(
    "a read-only turn is still allowed to change nothing",
    completionGatePrompt([], false, false) === ""
  );
  check(
    "generic nudge is blocked after a turn-limit continuation",
    !canRunNudge({
      nudges: 0,
      gateNudges: 0,
      turnLimitContinuations: 1,
      aborted: false,
    })
  );
  check(
    "completion gate may retry after a generic nudge",
    canRunNudge({
      nudges: 1,
      gateNudges: 0,
      turnLimitContinuations: 0,
      gateRetry: true,
      aborted: false,
    })
  );
  check(
    "completion gate may retry after a turn-limit continuation",
    canRunNudge({
      nudges: 1,
      gateNudges: 0,
      turnLimitContinuations: 1,
      gateRetry: true,
      aborted: false,
    })
  );
  check(
    "completion gate keeps retrying inside its consecutive-stall bound",
    canRunNudge({
      nudges: 1,
      gateNudges: COMPLETION_GATE_RETRIES - 1,
      turnLimitContinuations: 1,
      gateRetry: true,
      aborted: false,
    })
  );
  check(
    "completion gate stops after consecutive stalled retries",
    !canRunNudge({
      nudges: 1,
      gateNudges: COMPLETION_GATE_RETRIES,
      turnLimitContinuations: 1,
      gateRetry: true,
      aborted: false,
    })
  );
  const progressBefore = {
    completedSteps: 1,
    // This is deliberately unchanged below: the regression is a second
    // mutation to an already-counted file, not the first edit of a new file.
    changedFiles: 2,
    appliedEdits: 3,
    verificationObserved: false,
  };
  const sameFileEditProgress = { ...progressBefore, appliedEdits: 4 };
  const stepProgress = { ...progressBefore, completedSteps: 2 };
  const verificationProgress = {
    ...progressBefore,
    verificationObserved: true,
  };
  check(
    "another edit to the same file resets the gate stall count",
    sameFileEditProgress.changedFiles === progressBefore.changedFiles &&
      completionGateMadeProgress(progressBefore, sameFileEditProgress)
  );
  check(
    "a completed plan step resets the gate stall count",
    completionGateMadeProgress(progressBefore, stepProgress)
  );
  check(
    "successful verification resets the gate stall count",
    completionGateMadeProgress(progressBefore, verificationProgress)
  );
  check(
    "unchanged evidence remains a bounded stall",
    !completionGateMadeProgress(progressBefore, { ...progressBefore })
  );
  const retryCountAfterProgress = completionGateMadeProgress(
    progressBefore,
    sameFileEditProgress
  )
    ? 0
    : COMPLETION_GATE_RETRIES;
  check(
    "a progressing large task earns another bounded Claude chunk",
    canRunNudge({
      nudges: 1,
      gateNudges: retryCountAfterProgress,
      turnLimitContinuations: 1,
      gateRetry: true,
      aborted: false,
    })
  );
  // --- ExitPlanMode markdown -> checklist (the internal plan pass) ---
  const parsed = planFromMarkdown(
    TASK,
    [
      "Wire the tables API into the site map.",
      "",
      "1. **Add the tables query** — fetch sections in `src/api/tables.ts`",
      "2. Render them in `src/features/site-map/Canvas.tsx`",
      "3. Reflect orders back: update src/features/orders/store.ts too",
    ].join("\n")
  );
  check("markdown yields steps", parsed?.steps.length === 3, `${parsed?.steps.length}`);
  check(
    "goal is the lead line, not a step",
    parsed?.goal === "Wire the tables API into the site map.",
    parsed?.goal
  );
  check(
    "title splits at the em dash and drops markup",
    parsed?.steps[0]!.title === "Add the tables query",
    parsed?.steps[0]!.title
  );
  check(
    "backticked path becomes a step file",
    parsed?.steps[0]!.files[0] === "src/api/tables.ts",
    String(parsed?.steps[0]!.files)
  );
  check(
    "bare path is picked up without backticks",
    parsed?.steps[2]!.files[0] === "src/features/orders/store.ts",
    String(parsed?.steps[2]!.files)
  );
  // Files are what PlanTracker matches edits against, so a parsed plan has
  // to start its current step from a matching real edit.
  const liveTracker = new PlanTracker(new EventBus());
  liveTracker.setPlan(parsed!);
  const firstParsed = parsed!.steps[0]!.id;
  liveTracker.transitionStep(TASK, firstParsed, "in-progress");
  liveTracker.noteFileEdited(TASK, "src/api/tables.ts");
  liveTracker.transitionStep(TASK, firstParsed, "done");
  liveTracker.noteFileEdited(TASK, "src/features/site-map/Canvas.tsx");
  check(
    "parsed current step starts from a real edit",
    liveTracker.get(TASK)!.steps[1]!.status === "in-progress",
    liveTracker.get(TASK)!.steps[1]!.status
  );
  check("prose with no list is rejected", planFromMarkdown(TASK, "I'll fix it.") === null);

  // --- Crash recovery: disk survives a fresh tracker/process instance. ---
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-plan-"));
  try {
    const persisted: Plan = {
      id: "plan-recovery",
      taskId: "task-recovery",
      goal: "finish durable work",
      createdAt: Date.now(),
      steps: [
        { id: "r1", title: "completed work", files: [], status: "done" },
        { id: "r2", title: "interrupted work", files: ["src/a.ts"], status: "in-progress" },
        { id: "r3", title: "remaining work", files: ["src/b.ts"], status: "pending" },
      ],
    };
    const firstStore = new PlanCheckpointStore(tempRoot, pino({ level: "silent" }));
    const firstTracker = new PlanTracker(new EventBus(), firstStore);
    firstTracker.bindTask("conv-recovery", persisted.taskId, "original request");
    firstTracker.setPlan(persisted);

    const checkpointDir = path.join(tempRoot, ".atelier", "plans", "conv-recovery");
    check("checkpoint JSON exists", fs.existsSync(path.join(checkpointDir, "task-recovery.json")));
    check("checkpoint Markdown exists", fs.existsSync(path.join(checkpointDir, "task-recovery.md")));

    const restartedStore = new PlanCheckpointStore(tempRoot, pino({ level: "silent" }));
    const context = restartedStore.resumeContext("conv-recovery", "task-next");
    check("original request restored", context.includes("Original request: original request"));
    check("done work restored", context.includes("Done:\n- completed work"));
    check("interrupted work restored", context.includes("In progress when interrupted:\n- interrupted work"));
    check("todo work restored", context.includes("Todo:\n- remaining work"));
    firstStore.removeConversation("conv-recovery");
    firstTracker.updateStep("task-recovery", "r3", "in-progress");
    check("deleted session checkpoint stays deleted", !fs.existsSync(checkpointDir));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(fail === 0 ? "\nall plan cases pass" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
