/**
 * Referents: the things a terse turn points AT — the picked note, a typed
 * path, the suggestion being approved — must survive into the prompt.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  composePromptFilePrompt,
  promptFilePathOf,
  typedInstructionsOf,
} from "@atelier/shared";
import { parseTypedPaths } from "../src/workspace/scope/mentions.js";
import { inScope, type SessionScope } from "../src/workspace/scope/index.js";

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures += 1;
}

// --- the picked note names itself in the prompt ------------------------
const NOTE = "# Capping warning\n\nin @spndx-admin-console send a warning.";
const NOTE_PATH = ".atelier/Capping-warning-new-requirement.md";

const withTyped = composePromptFilePrompt(NOTE, "update this md file", NOTE_PATH);
check("the prompt names the note", withTyped.includes(NOTE_PATH));
check("the path is recoverable", promptFilePathOf(withTyped) === NOTE_PATH);
check(
  "the typed half is still separable",
  typedInstructionsOf(withTyped, NOTE) === "update this md file"
);

const noteOnly = composePromptFilePrompt(NOTE, "", NOTE_PATH);
check(
  "a note run as-is reports no typed instructions",
  typedInstructionsOf(noteOnly, NOTE) === ""
);
check(
  "a prompt with no note path is unchanged",
  promptFilePathOf("just a normal prompt") === ""
);

// --- a typed path grants access despite a lock -------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-scope-"));
fs.mkdirSync(path.join(root, ".atelier"), { recursive: true });
fs.writeFileSync(path.join(root, ".atelier", "note.md"), "# note");
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs", "plan.md"), "# plan");

const typed = parseTypedPaths(
  "i mean update this .atelier/note.md based on what was touched",
  root
);
check("a bare typed path is recognised", typed.includes(".atelier/note.md"));
check(
  "a path-shaped string that names nothing is ignored",
  parseTypedPaths("see src/nope/missing.ts for this", root).length === 0
);
check(
  "prose is not mistaken for a path",
  parseTypedPaths("fix it and/or tell me", root).length === 0
);

const locked: SessionScope = {
  roots: ["FinOps_Backend", "spndx-admin-console"],
  anchors: [],
  allowed: parseTypedPaths("update docs/plan.md please", root),
  source: "mention",
  changed: false,
};
check("the lock still refuses what was never named", !inScope(locked, "other/x.ts"));
check("a typed path is allowed through the lock", inScope(locked, "docs/plan.md"));
check("notes are always in scope", inScope(locked, ".atelier/note.md"));
check("locked roots still pass", inScope(locked, "FinOps_Backend/src/app.ts"));

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nreference smoke passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
