import assert from "node:assert/strict";
import type { HookConfig } from "@atelier/protocol";
import { EventBus } from "../events/event-bus.js";
import {
  RepeatCallGuard,
  callKey,
  pathsFrom,
  REPEAT_CALL_HOOK_ID,
  REPEAT_CALL_HOOK_NAME,
  REPEAT_CALL_MATCHER,
} from "./repeat-call-guard.js";

const TASK = "task-repeat-call";
const hook: HookConfig = {
  id: REPEAT_CALL_HOOK_ID,
  name: REPEAT_CALL_HOOK_NAME,
  enabled: true,
  event: "preTool",
  matcher: REPEAT_CALL_MATCHER,
  action: "block",
};

function ctxFor(toolName: string, input: unknown) {
  return { toolName, input, taskId: TASK, hook };
}

const SEARCH = { query: "meetingSchema" };
const RESULT = {
  matches: [
    { path: "src/routes/superAdminTenants.ts", line: 12 },
    { path: "src/routes/superAdminTenants.ts", line: 40 },
  ],
  scanned: 812,
};

async function main(): Promise<void> {
  const bus = new EventBus();
  const guard = new RepeatCallGuard(bus);
  const blocked: string[] = [];
  bus.subscribe((event) => {
    if (event.topic === "hook.blocked") {
      blocked.push(String((event.payload as { reason?: string }).reason));
    }
  });

  // Nothing noted yet: the first search of a turn always runs.
  assert.equal(
    await guard.check(ctxFor("search_text", SEARCH)),
    undefined,
    "the first lookup is never refused"
  );

  guard.note(TASK, "search_text", SEARCH, RESULT);

  const repeat = await guard.check(ctxFor("search_text", SEARCH));
  assert.equal(repeat?.allowed, false, "the same search does not run twice");
  assert.match(repeat?.reason ?? "", /already ran as call 1/);
  assert.match(
    repeat?.reason ?? "",
    /superAdminTenants\.ts/,
    "the refusal hands back what the first call found"
  );

  // Speed bump, not a wall — the house convention. A model that insists
  // gets through, so a wrong premise can never deadlock a turn.
  assert.equal(
    await guard.check(ctxFor("search_text", SEARCH)),
    undefined,
    "an immediate repeat of a refused call is allowed"
  );
  assert.equal(blocked.length, 1, "and it is refused once, not every time");

  // A different question is a different call.
  assert.equal(
    await guard.check(ctxFor("search_text", { query: "scheduleUpgradeMeeting" })),
    undefined,
    "a new query runs"
  );
  assert.equal(
    await guard.check(ctxFor("search_text", { ...SEARCH, glob: "src/**/*.ts" })),
    undefined,
    "narrowing with a glob is a new call"
  );

  // Tools that change something, or whose answer legitimately changes, are
  // never matched.
  guard.note(TASK, "run_terminal", { command: "npm test" }, { exitCode: 0 });
  assert.equal(
    await guard.check(ctxFor("run_terminal", { command: "npm test" })),
    undefined,
    "reruns of a command are the model's business"
  );

  // A read is keyed on its arguments, since the result carries no path.
  guard.note(TASK, "read_file", { path: "./Src/App.tsx" }, { content: "x" });
  const reread = await guard.check(ctxFor("read_file", { path: "src/app.tsx" }));
  assert.equal(reread?.allowed, false, "path spelling does not defeat the key");
  assert.match(reread?.reason ?? "", /Src\/App\.tsx/);

  // An edit makes every earlier answer stale, so the ledger clears.
  guard.invalidate(TASK);
  assert.equal(
    await guard.check(ctxFor("search_text", SEARCH)),
    undefined,
    "after an edit the same search is a new question"
  );

  guard.note(TASK, "search_text", SEARCH, RESULT);
  guard.release(TASK);
  assert.equal(
    await guard.check(ctxFor("search_text", SEARCH)),
    undefined,
    "releasing a task forgets its lookups"
  );

  // Seeded from earlier turns: the no-re-investigation rule, enforced.
  const later = new RepeatCallGuard(bus);
  later.seedEarlier(TASK, {
    searches: [
      { tool: "search_text", query: "meetingSchema", paths: ["src/a.ts"] },
      { tool: "run_terminal", query: "npm test", paths: [] },
    ],
    inlinedPaths: ["src/routes/superAdminTenants.ts"],
  });

  const reGrep = await later.check(ctxFor("search_text", SEARCH));
  assert.equal(reGrep?.allowed, false, "an earlier turn's search is refused");
  assert.match(reGrep?.reason ?? "", /earlier turn of this conversation/);
  assert.match(
    reGrep?.reason ?? "",
    /PREVIOUSLY GATHERED CONTEXT/,
    "the refusal says where the answer already is"
  );
  assert.match(reGrep?.reason ?? "", /src\/a\.ts/);

  const reRead = await later.check(
    ctxFor("read_file", { path: "src/routes/superAdminTenants.ts" })
  );
  assert.equal(reRead?.allowed, false, "an inlined file is not re-read");
  assert.equal(
    await later.check(
      ctxFor("read_file", { path: "src/routes/superAdminTenants.ts" })
    ),
    undefined,
    "but insisting still gets the file — a seeded belief can be wrong"
  );

  // A file the recall did NOT inline has no fresh copy in context, so it
  // must stay openable.
  assert.equal(
    await later.check(ctxFor("read_file", { path: "src/other.ts" })),
    undefined,
    "a file not carried in this turn can still be read"
  );
  // Seeding never matches a tool the guard does not cover.
  assert.equal(
    await later.check(ctxFor("run_terminal", { query: "npm test" })),
    undefined,
    "a non-repeatable tool is never seeded"
  );
  // An edit reopens everything, earlier turns included.
  later.invalidate(TASK);
  assert.equal(
    await later.check(ctxFor("search_text", SEARCH)),
    undefined,
    "an edit clears the seeded ledger too"
  );

  // Key normalization: argument order and casing are not meaning, but an
  // absent argument must not collide with a present one.
  assert.equal(
    callKey("search_text", { query: " Foo ", glob: "src" }),
    callKey("search_text", { glob: "SRC", query: "foo" })
  );
  assert.notEqual(
    callKey("search_text", { query: "foo" }),
    callKey("search_text", { query: "foo", regex: true })
  );
  assert.notEqual(
    callKey("read_file", { path: "a.ts" }),
    callKey("list_dir", { path: "a.ts" }),
    "the tool is part of the identity"
  );

  // Path extraction is shape-tolerant: results differ per tool.
  assert.deepEqual(pathsFrom(RESULT), ["src/routes/superAdminTenants.ts"]);
  assert.deepEqual(pathsFrom({ chunks: [{ file: "a.ts" }] }), ["a.ts"]);
  assert.deepEqual(pathsFrom({ content: "no paths here" }), []);
}

void main();
