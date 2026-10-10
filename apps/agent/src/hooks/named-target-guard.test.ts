import assert from "node:assert/strict";
import type { HookConfig } from "@atelier/protocol";
import { EventBus } from "../events/event-bus.js";
import {
  NamedTargetGuard,
  NAMED_TARGET_HOOK_ID,
  NAMED_TARGET_HOOK_NAME,
  NAMED_TARGET_MATCHER,
  pathMatches,
} from "./named-target-guard.js";

const hook: HookConfig = {
  id: NAMED_TARGET_HOOK_ID,
  name: NAMED_TARGET_HOOK_NAME,
  enabled: true,
  event: "preTool",
  matcher: NAMED_TARGET_MATCHER,
  action: "block",
};

function ctxFor(taskId: string, toolName: string, input: unknown) {
  return { toolName, input, taskId, hook };
}

const EDIT_ELSEWHERE = {
  path: "src/components/Sidebar.tsx",
  oldString: "<nav>",
  newString: "<nav className=\"x\">",
};

function harness(): { guard: NamedTargetGuard; blocked: string[] } {
  const bus = new EventBus();
  const blocked: string[] = [];
  bus.subscribe((event) => {
    if (event.topic === "hook.blocked") {
      blocked.push(String((event.payload as { reason?: string }).reason));
    }
  });
  return { guard: new NamedTargetGuard(bus), blocked };
}

async function testEditElsewhereIsRefusedUntilLooked(): Promise<void> {
  const { guard, blocked } = harness();
  const task = "t-look";
  guard.arm(task, { paths: [], literals: ["Save changes"] });

  const first = await guard.check(ctxFor(task, "replace_code", EDIT_ELSEWHERE));
  assert.equal(first?.allowed, false, "an edit elsewhere waits on the look");
  assert.match(first?.reason ?? "", /names "Save changes"/);
  assert.doesNotMatch(first?.reason ?? "", /REFERENT/);
  assert.equal(blocked.length, 1, "the refusal is visible on the timeline");

  const plan = await guard.check(
    ctxFor(task, "set_plan", { steps: [{ title: "Fix nav", files: ["src/nav.tsx"] }] })
  );
  assert.equal(plan?.allowed, false, "planning around the wrong file waits too");

  // A search whose query carries the literal, in any case, is the look.
  guard.note(task, "search_text", { query: "save CHANGES" }, { matches: [] });
  assert.ok(guard.hasLooked(task));
  assert.equal(
    await guard.check(ctxFor(task, "replace_code", EDIT_ELSEWHERE)),
    undefined,
    "once looked, edits anywhere go through"
  );
}

async function testReadOfNamedPathCounts(): Promise<void> {
  const { guard } = harness();
  const task = "t-read";
  guard.arm(task, { paths: ["src/pages/Login.tsx"], literals: [] });
  assert.equal(
    (await guard.check(ctxFor(task, "write_file", { path: "src/x.ts", content: "" })))
      ?.allowed,
    false
  );
  // A search that mentions nothing named does not count…
  guard.note(task, "search_text", { query: "useAuth" }, {});
  assert.ok(!guard.hasLooked(task), "an unrelated search is not a look");
  // …a read_many_files that includes the file (by basename) does.
  guard.note(
    task,
    "read_many_files",
    { files: [{ path: "./src/Pages/login.tsx", startLine: 1 }] },
    {}
  );
  assert.ok(guard.hasLooked(task), "reading the named file is the look");
}

async function testSearchForBasenameCounts(): Promise<void> {
  const { guard } = harness();
  const task = "t-basename";
  guard.arm(task, { paths: ["apps/web/src/hooks/useGitViewModel.ts"], literals: [] });
  guard.note(task, "search_symbols", { query: "useGitViewModel.ts" }, {});
  assert.ok(guard.hasLooked(task), "a search naming the file's basename counts");

  const graph = "t-graph";
  guard.arm(graph, { paths: [], literals: ["budget.alert.limit"] });
  guard.note(
    graph,
    "query_knowledge_graph",
    { scope: "symbol", target: "budget.alert.limit" },
    {}
  );
  assert.ok(guard.hasLooked(graph), "query_knowledge_graph's target is its query");
}

async function testEditOnTargetIsTheLook(): Promise<void> {
  const { guard } = harness();
  const task = "t-edit-target";
  guard.arm(task, { paths: ["src/i18n/en.json"], literals: ["Sign in to continue"] });

  // Editing the named file itself goes through and marks the look.
  const onTarget = await guard.check(
    ctxFor(task, "replace_code", {
      path: "src/i18n/en.json",
      oldString: '"login": "Login"',
      newString: '"login": "Sign in"',
    })
  );
  assert.equal(onTarget, undefined, "an edit that lands on the named file is allowed");
  assert.ok(guard.hasLooked(task));

  // replace_many whose oldString holds the literal counts as well.
  const many = "t-many";
  guard.arm(many, { paths: [], literals: ["Sign in to continue"] });
  const decision = await guard.check(
    ctxFor(many, "replace_many", {
      edits: [
        { path: "src/other.tsx", oldString: "x", newString: "y" },
        {
          path: "src/Welcome.tsx",
          oldString: "<h1>Sign in  to continue</h1>",
          newString: "<h1>Welcome back</h1>",
        },
      ],
    })
  );
  assert.equal(decision, undefined, "replacing the literal text is the look");

  // set_plan whose step files include the named path counts.
  const plan = "t-plan";
  guard.arm(plan, { paths: ["src/i18n/en.json"], literals: [] });
  const planned = await guard.check(
    ctxFor(plan, "set_plan", {
      steps: [{ title: "Update copy", files: ["src/i18n/en.json"] }],
    })
  );
  assert.equal(planned, undefined, "a plan step on the named file is allowed");
}

async function testStandsDownAfterThreeRefusals(): Promise<void> {
  const { guard, blocked } = harness();
  const task = "t-stand-down";
  guard.arm(task, { paths: [], literals: ["Something went wrong"] });
  for (let i = 0; i < 3; i += 1) {
    const decision = await guard.check(ctxFor(task, "replace_code", EDIT_ELSEWHERE));
    assert.equal(decision?.allowed, false, `refusal ${i + 1}`);
  }
  assert.equal(
    await guard.check(ctxFor(task, "replace_code", EDIT_ELSEWHERE)),
    undefined,
    "the fourth attempt goes through — the target list may be wrong"
  );
  assert.equal(blocked.length, 3, "refused exactly three times");
}

async function testBoundaries(): Promise<void> {
  const { guard } = harness();
  // Nothing named: nothing armed, nothing refused.
  guard.arm("t-empty", { paths: [], literals: ["  "] });
  assert.ok(!guard.isArmed("t-empty"));
  assert.equal(
    await guard.check(ctxFor("t-empty", "replace_code", EDIT_ELSEWHERE)),
    undefined
  );
  // Unarmed tasks and non-gated tools are untouched.
  assert.equal(
    await guard.check(ctxFor("t-unknown", "write_file", { path: "a.ts", content: "" })),
    undefined
  );
  guard.arm("t-tool", { paths: ["a.ts"], literals: [] });
  assert.equal(
    await guard.check(ctxFor("t-tool", "run_terminal", { command: "npm test" })),
    undefined,
    "only editing and planning tools are gated"
  );
  // Release forgets the task.
  guard.release("t-tool");
  assert.ok(!guard.isArmed("t-tool"));
  assert.equal(
    await guard.check(ctxFor("t-tool", "replace_code", EDIT_ELSEWHERE)),
    undefined
  );
}

function testPathMatching(): void {
  assert.ok(pathMatches("src/App.tsx", "App.tsx"), "basename");
  assert.ok(pathMatches("apps/web/src/App.tsx", "src/app.tsx"), "posix suffix, any case");
  assert.ok(pathMatches("./src\\App.tsx", "src/App.tsx"), "windows separators");
  assert.ok(!pathMatches("src/App.test.tsx", "App.tsx"), "a different basename");
  assert.ok(!pathMatches("", "App.tsx"));
}

async function main(): Promise<void> {
  testPathMatching();
  await testEditElsewhereIsRefusedUntilLooked();
  await testReadOfNamedPathCounts();
  await testSearchForBasenameCounts();
  await testEditOnTargetIsTheLook();
  await testStandsDownAfterThreeRefusals();
  await testBoundaries();
  console.log("named-target-guard: all assertions passed");
}

void main();
