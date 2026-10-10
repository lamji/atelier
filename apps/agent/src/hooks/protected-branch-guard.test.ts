import assert from "node:assert/strict";
import type { HookConfig } from "@atelier/protocol";
import { EventBus } from "../events/event-bus.js";
import {
  ProtectedBranchGuard,
  matchingPattern,
  PROTECTED_BRANCH_HOOK_ID,
  PROTECTED_BRANCH_HOOK_NAME,
  PROTECTED_BRANCH_MATCHER,
} from "./protected-branch-guard.js";

const TASK = "task-protected-branch";
const hook: HookConfig = {
  id: PROTECTED_BRANCH_HOOK_ID,
  name: PROTECTED_BRANCH_HOOK_NAME,
  enabled: true,
  event: "preTool",
  matcher: PROTECTED_BRANCH_MATCHER,
  action: "block",
};

function ctxFor(toolName: string) {
  return { toolName, input: { path: "src/app.ts" }, taskId: TASK, hook };
}

async function main(): Promise<void> {
  // ── matching ────────────────────────────────────────────────────────
  assert.equal(matchingPattern("main", ["main"]), "main");
  assert.equal(matchingPattern("develop", ["main"]), null);
  // Case-insensitive: a protection that lapses on "Main" is not one.
  assert.equal(matchingPattern("Main", ["main"]), "main");
  assert.equal(matchingPattern("main", ["MAIN"]), "MAIN");
  // Globs, for the families nobody maintains a rule-per-branch for.
  assert.equal(matchingPattern("release/2.1", ["release/*"]), "release/*");
  assert.equal(matchingPattern("release", ["release/*"]), null);
  // A glob must not swallow a deeper path it was not written for.
  assert.equal(matchingPattern("release/2.1/hotfix", ["release/*"]), null);
  // The rule that matched is reported, so the refusal can name it.
  assert.equal(
    matchingPattern("SPDNX-Dev", ["main", "spdnx-*", "release/*"]),
    "spdnx-*"
  );
  // Blank entries are ignored rather than matching everything.
  assert.equal(matchingPattern("main", ["", "   "]), null);
  assert.equal(matchingPattern("anything", []), null);

  // ── the guard ───────────────────────────────────────────────────────
  const bus = new EventBus();
  let patterns: string[] = [];
  const guard = new ProtectedBranchGuard(
    bus,
    () => patterns,
    async () => "main"
  );
  const blocked: string[] = [];
  bus.subscribe((event) => {
    if (event.topic === "hook.blocked") {
      blocked.push(String((event.payload as { reason?: string }).reason));
    }
  });

  // Nothing protected: every edit passes, which is the default install.
  assert.equal(await guard.check(ctxFor("write_file")), undefined);

  patterns = ["main"];
  const refused = await guard.check(ctxFor("write_file"));
  assert.equal(refused?.allowed, false, "an edit on main is refused");
  assert.match(refused?.reason ?? "", /"main" is a protected branch/);
  assert.match(refused?.reason ?? "", /Protected tab/);
  assert.match(
    refused?.reason ?? "",
    /Do NOT try to switch branches yourself/,
    "the model must not route around it by checking out"
  );
  assert.equal(blocked.length, 1, "the refusal is on the timeline");

  // Every edit tool, not just the first one.
  for (const tool of ["replace_code", "replace_many"]) {
    assert.equal((await guard.check(ctxFor(tool)))?.allowed, false, tool);
  }
  // Publishing is blocked too: a commit on a protected branch is awkward
  // to undo and a push cannot be undone at all.
  const commitTool = {
    toolName: "git",
    input: { action: "commit", message: "wip" },
    taskId: TASK,
    hook,
  };
  const commitRefused = await guard.check(commitTool);
  assert.equal(commitRefused?.allowed, false, "git tool commit is refused");
  assert.match(commitRefused?.reason ?? "", /may not commit to it/);

  for (const command of ["git commit -m x", "git push", "git add -A && git push origin main"]) {
    const refusedRun = await guard.check({
      toolName: "run_terminal",
      input: { command },
      taskId: TASK,
      hook,
    });
    assert.equal(refusedRun?.allowed, false, command);
  }

  // Reading and inspecting are untouched — a protected branch is not a
  // read-only session, and a terminal is not automatically suspect.
  for (const tool of ["read_file", "search_text"]) {
    assert.equal(await guard.check(ctxFor(tool)), undefined, tool);
  }
  for (const command of ["npm test", "git status", "ls -la", "git log"]) {
    assert.equal(
      await guard.check({
        toolName: "run_terminal",
        input: { command },
        taskId: TASK,
        hook,
      }),
      undefined,
      command
    );
  }
  assert.equal(
    await guard.check({
      toolName: "git",
      input: { action: "status" },
      taskId: TASK,
      hook,
    }),
    undefined,
    "read-only git actions pass"
  );

  // The branch comes from the bus, so a checkout made anywhere — including
  // an external terminal — moves the protection with it.
  bus.publish("git.state.changed", gitState("feature/x"));
  assert.equal(
    await guard.check(ctxFor("write_file")),
    undefined,
    "moving off the protected branch lifts it"
  );
  bus.publish("git.state.changed", gitState("main"));
  assert.equal(
    (await guard.check(ctxFor("write_file")))?.allowed,
    false,
    "and moving back re-applies it"
  );

  // Unprotecting takes effect without a restart: patterns are read live.
  patterns = [];
  assert.equal(await guard.check(ctxFor("write_file")), undefined);

  // A guard that cannot tell which branch this is has nothing to protect,
  // and must not block on a guess.
  const blind = new ProtectedBranchGuard(
    new EventBus(),
    () => ["main"],
    async () => null
  );
  assert.equal(await blind.check(ctxFor("write_file")), undefined);
}

/** The event's real shape; the bus validates it. */
function gitState(branch: string) {
  return {
    branch,
    isClean: true,
    changedFiles: 0,
    conflicts: 0,
    mergeKind: null,
  };
}

void main();
