import assert from "node:assert/strict";
import type { HookConfig } from "@atelier/protocol";
import { EventBus } from "../events/event-bus.js";
import { NoteAccessRegistry } from "../notes/note-access.js";
import {
  NoteWriteGuard,
  NOTE_WRITE_HOOK_ID,
  NOTE_WRITE_HOOK_NAME,
} from "./note-write-guard.js";

const TASK = "task-note-write";
const NOTE = ".atelier/8-17-2026-sprint.md";
const OTHER = ".atelier/8-10-2026-sprint.md";

const hook: HookConfig = {
  id: NOTE_WRITE_HOOK_ID,
  name: NOTE_WRITE_HOOK_NAME,
  enabled: true,
  event: "preTool",
  matcher: "write_file|replace_code|replace_many",
  action: "block",
};

function call(toolName: string, input: unknown) {
  return { toolName, input, taskId: TASK, hook };
}

async function main(): Promise<void> {
  const bus = new EventBus();
  const access = new NoteAccessRegistry();
  const onDisk = new Set([NOTE, OTHER]);
  const guard = new NoteWriteGuard(
    access,
    async (path) => onDisk.has(path),
    bus
  );
  const blocked: string[] = [];
  bus.subscribe((event) => {
    if (event.topic === "hook.blocked") {
      blocked.push(String((event.payload as { reason?: string }).reason));
    }
  });

  // The note this turn was sent from, plus one the user typed about.
  access.grant(
    TASK,
    `Prompt file: ${NOTE}\n(header)\n\nnote body mentioning ${OTHER}\n\n` +
      "Additional instructions:\nship it",
    NOTE
  );

  const replaced = await guard.check(call("write_file", { path: NOTE }));
  assert.equal(replaced?.allowed, false, "a note is never restated in full");
  assert.match(replaced?.reason ?? "", /replace_code/);

  assert.equal(
    await guard.check(call("replace_code", { path: NOTE })),
    undefined,
    "the referenced note may be patched"
  );

  const foreign = await guard.check(call("replace_code", { path: OTHER }));
  assert.equal(foreign?.allowed, false, "a note quoted BY the note is not a target");
  assert.match(foreign?.reason ?? "", /not referenced/);

  const batched = await guard.check(
    call("replace_many", {
      edits: [{ path: "src/app.ts" }, { path: OTHER }],
    })
  );
  assert.equal(batched?.allowed, false, "every path in a batch is checked");

  assert.equal(
    await guard.check(call("write_file", { path: ".atelier/new-note.md" })),
    undefined,
    "a note that does not exist yet destroys nothing"
  );
  assert.equal(
    await guard.check(call("write_file", { path: "src/app.ts" })),
    undefined,
    "code is not a note"
  );

  // A turn that typed the path gets it, without the composer pill.
  access.grant("task-typed", `update ${OTHER} with the new dates`);
  assert.equal(
    await guard.check({
      ...call("replace_code", { path: OTHER }),
      taskId: "task-typed",
    }),
    undefined,
    "naming a note in the prompt is a reference"
  );

  assert.equal(blocked.length, 3, "every refusal is visible on the timeline");

  access.release(TASK);
  const afterRelease = await guard.check(call("replace_code", { path: NOTE }));
  assert.equal(afterRelease?.allowed, false, "access ends with the task");
}

void main();
