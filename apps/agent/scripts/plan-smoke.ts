/**
 * Plan auto-advance smoke: the checklist must move from real edits even
 * when the model never calls update_plan_step.
 *
 *   pnpm --filter @atelier/agent smoke:plan
 */
import { EventBus } from "../src/events/event-bus.js";
import { PlanTracker } from "../src/orchestrator/plan-tracker.js";
import type { Plan } from "@atelier/protocol";

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
  bus.subscribe((e) => {
    if (e.topic === "plan.step.updated") {
      updates.push(e.payload as { stepId: string; status: string });
    }
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

  // Edit step 2's file: step 2 in-progress, step 1 done (monotonic).
  tracker.noteFileEdited(TASK, "a/Symbol.tsx");
  check("s1 done after later edit", statusOf("s1") === "done", statusOf("s1"));
  check("s2 in-progress", statusOf("s2") === "in-progress", statusOf("s2"));
  check("s3 still pending", statusOf("s3") === "pending");

  // Edit the shared Canvas file (steps 3 & 4): earliest not-done wins (s3).
  tracker.noteFileEdited(TASK, "a/Canvas.tsx");
  check("s2 done", statusOf("s2") === "done");
  check("s3 in-progress", statusOf("s3") === "in-progress");

  // Path drift (leading ./ and case) still matches.
  tracker.noteFileEdited(TASK, "./A/Modal.tsx");
  check("s5 in-progress via fuzzy path", statusOf("s5") === "in-progress");
  check("s4 done as earlier step", statusOf("s4") === "done");

  // Completion finalises the remainder.
  tracker.completeAll(TASK);
  check(
    "all done after completeAll",
    tracker.get(TASK)!.steps.every((s) => s.status === "done")
  );
  check("events were published", updates.length > 0, `${updates.length} updates`);

  console.log(fail === 0 ? "\nall plan cases pass" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
