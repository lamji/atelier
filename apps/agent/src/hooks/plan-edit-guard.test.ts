import assert from "node:assert/strict";
import type { HookConfig, Plan } from "@atelier/protocol";
import { EventBus } from "../events/event-bus.js";
import { PlanTracker } from "../orchestrator/plan-tracker.js";
import {
  PlanEditGuard,
  PLAN_EDIT_HOOK_ID,
  PLAN_EDIT_HOOK_NAME,
} from "./plan-edit-guard.js";

const TASK = "task-plan-edit";
const hook: HookConfig = {
  id: PLAN_EDIT_HOOK_ID,
  name: PLAN_EDIT_HOOK_NAME,
  enabled: true,
  event: "preTool",
  matcher: "write_file|replace_code|replace_many",
  action: "block",
};
const editContext = {
  toolName: "replace_code",
  input: { path: "src/view.tsx" },
  taskId: TASK,
  hook,
};

async function main(): Promise<void> {
  const bus = new EventBus();
  const tracker = new PlanTracker(bus);
  const guard = new PlanEditGuard(tracker, bus);
  const blocked: string[] = [];
  bus.subscribe((event) => {
    if (event.topic === "hook.blocked") {
      blocked.push(String((event.payload as { reason?: string }).reason));
    }
  });

  assert.equal(await guard.check(editContext), undefined, "direct tasks stay unguarded");

  tracker.requirePlan(TASK);
  const missing = await guard.check(editContext);
  assert.equal(missing?.allowed, false);
  assert.match(missing?.reason ?? "", /set_plan/);

  const plan: Plan = {
    id: "plan-1",
    taskId: TASK,
    goal: "change the view",
    createdAt: 0,
    steps: [
      {
        id: "step-1",
        title: "Update the view",
        files: ["src/view.tsx"],
        status: "pending",
      },
    ],
  };
  tracker.setPlan(plan);

  const pending = await guard.check(editContext);
  assert.equal(pending?.allowed, false);
  assert.match(pending?.reason ?? "", /update_plan_step/);

  assert.equal(
    tracker.transitionStep(TASK, "step-1", "in-progress").ok,
    true
  );
  assert.equal(
    await guard.check(editContext),
    undefined,
    "an active step owns the edit"
  );

  assert.equal(tracker.transitionStep(TASK, "step-1", "done").ok, true);
  const completed = await guard.check(editContext);
  assert.equal(completed?.allowed, false);
  assert.match(completed?.reason ?? "", /Append/);

  assert.equal(blocked.length, 3, "every refusal is visible on the timeline");

  tracker.clear(TASK);
  assert.equal(
    await guard.check(editContext),
    undefined,
    "clearing a task removes its plan requirement"
  );
}

void main();
