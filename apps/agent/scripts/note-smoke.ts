/**
 * Markdown-note lifecycle smoke: a note picked in the composer must go
 * todo -> in-progress when its task starts and -> review with an appended
 * report when it ends, WITHOUT losing a byte of what the user wrote.
 *
 *   pnpm --filter @atelier/agent smoke:note
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import {
  composePromptFilePrompt,
  conversationTitle,
  typedInstructionsOf,
  upsertFrontmatterStatus,
} from "@atelier/shared";
import { EventBus } from "../src/events/event-bus.js";
import { PathGuard } from "../src/workspace/path-guard.js";
import { WorkspaceIgnore } from "../src/workspace/ignore.js";
import { FileService } from "../src/workspace/file-service.js";
import { NoteJournal } from "../src/notes/note-journal.js";
import { renderNoteReport, stripReports } from "../src/notes/note-report.js";

const NOTE = ".atelier/checkout-bug.md";
const ORIGINAL = [
  "# Checkout bug",
  "",
  "The cart total ignores the discount code on the second render.",
  "",
  "- [ ] reproduce",
  "- [ ] fix",
  "",
].join("\n");

let fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-note-"));
  await fs.mkdir(path.join(root, ".atelier"), { recursive: true });
  await fs.writeFile(path.join(root, NOTE), ORIGINAL, "utf8");

  const bus = new EventBus();
  const diffPaths: string[] = [];
  bus.subscribe((e) => {
    if (e.topic === "diff.created") {
      diffPaths.push((e.payload as { path: string }).path);
    }
  });
  const guard = new PathGuard(root);
  const files = new FileService(guard, new WorkspaceIgnore(root, []), bus);
  const journal = new NoteJournal({
    files,
    workspaceRoot: root,
    log: pino({ level: "silent" }),
  });
  const read = async () => (await files.readFile(NOTE)).content;

  // --- pure helpers ------------------------------------------------------
  const prompt = composePromptFilePrompt(ORIGINAL, "start with the fix");
  check(
    "typed instructions survive the round trip",
    typedInstructionsOf(prompt, ORIGINAL) === "start with the fix",
    typedInstructionsOf(prompt, ORIGINAL)
  );
  // The status line is rewritten the moment the task starts, so the note on
  // disk no longer matches the prompt captured at send time byte for byte.
  const flipped = upsertFrontmatterStatus(ORIGINAL, "in-progress");
  check(
    "note-only prompt yields no typed request",
    typedInstructionsOf(ORIGINAL, flipped) === ""
  );
  check(
    "an ordinary prompt is returned untouched",
    typedInstructionsOf("fix the cart", flipped) === "fix the cart"
  );

  // --- the note names the session ---------------------------------------
  check(
    "the note's heading is its title",
    (await journal.title(NOTE)) === "Checkout bug",
    String(await journal.title(NOTE))
  );
  check(
    "a long heading is elided the same way on both ends",
    conversationTitle("x".repeat(80)) === `${"x".repeat(57)}…`
  );
  check(
    "a file outside .atelier has no note title",
    (await journal.title("src/main.ts")) === null
  );

  // --- status flip -------------------------------------------------------
  await journal.markInProgress(NOTE);
  const started = await read();
  check("status flips to in-progress", /^status: in-progress$/m.test(started));
  check(
    "the user's content is intact after the flip",
    started.includes("- [ ] reproduce") && started.includes("# Checkout bug")
  );

  // --- report append -----------------------------------------------------
  await journal.writeReport(NOTE, {
    taskId: "task-1",
    status: "completed",
    request: prompt,
    intentKind: "fix",
    intentSummary: "discount ignored on re-render",
    planGoal: "Recompute the total when the code changes",
    steps: [
      {
        title: "Recompute on code change",
        detail: "add the code to the memo deps",
        files: ["src/cart/useTotal.ts"],
        status: "done",
      },
      { title: "Cover it", detail: "", files: [], status: "pending" },
    ],
    changedFiles: ["src/cart/useTotal.ts"],
    validation: [
      { kind: "typecheck", ok: true, findings: [], durationMs: 10 },
      { kind: "lint", ok: false, findings: [], durationMs: 10 },
    ],
    reviewVerdict: "pass",
    durationMs: 92_000,
    at: Date.UTC(2026, 6, 29, 12, 3),
    assistantText: "Added the discount code to the memo dependency list.",
  });

  const done = await read();
  check("status moves to review", /^status: review$/m.test(done));
  check(
    "the original content is still there, unedited",
    done.includes("The cart total ignores the discount code on the second render.") &&
      done.includes("- [ ] reproduce")
  );
  check("a report section was appended", done.includes("## Implementation report"));
  check("the request is recorded", done.includes("start with the fix"));
  check(
    "the note is NOT quoted back into itself",
    done.split("# Checkout bug").length === 2,
    `${done.split("# Checkout bug").length - 1} copies`
  );
  check("files touched are listed", done.includes("`src/cart/useTotal.ts`"));
  check("the completed step is listed", done.includes("Recompute on code change"));
  check(
    "the unfinished step is not claimed as implemented",
    done.includes("Not completed in this run:")
  );
  check("validation is recorded", done.includes("lint: **failing**"));
  check("the review verdict is recorded", done.includes("review **passed**"));
  // The narrative pass is a live model call, so which of the two shapes
  // lands depends on whether the host can reach a provider. Both are valid;
  // a report with NEITHER is the bug — that is an entry with no prose at all.
  check(
    "the entry carries prose, written or fallen back to",
    done.includes("### Issue") || done.includes("### Summary (from the agent")
  );
  // The appended entry adds its own `##` heading. The session must keep
  // reading as the note, not as the last report written into it.
  check(
    "the title survives an appended report",
    (await journal.title(NOTE)) === "Checkout bug",
    String(await journal.title(NOTE))
  );
  check(
    "the catalog is told to refresh via diff.created",
    diffPaths.filter((p) => p === NOTE).length >= 2,
    `${diffPaths.length} diffs`
  );

  // --- a second run appends, it does not replace -------------------------
  await journal.markInProgress(NOTE);
  await journal.writeReport(NOTE, {
    taskId: "task-2",
    status: "cancelled",
    request: "and cover it with a test",
    intentKind: "fix",
    intentSummary: "add the test",
    planGoal: "Cover the regression",
    steps: [],
    changedFiles: [],
    validation: [],
    reviewVerdict: null,
    durationMs: 4_000,
    at: Date.UTC(2026, 6, 29, 12, 40),
    assistantText: "",
  });
  const twice = await read();
  check(
    "both runs are on the note",
    twice.split("## Implementation report").length === 3,
    `${twice.split("## Implementation report").length - 1} reports`
  );
  check(
    "an interrupted run leaves the note in progress",
    /^status: in-progress$/m.test(twice)
  );
  check("the interruption is stated", twice.includes("### Interrupted"));
  check(
    "earlier reports are stripped from the narrative briefing",
    !stripReports(twice).includes("## Implementation report") &&
      stripReports(twice).includes("- [ ] reproduce")
  );

  // --- guards ------------------------------------------------------------
  await journal.markInProgress("src/main.ts");
  check(
    "a path outside .atelier is refused",
    !(await fs
      .stat(path.join(root, "src/main.ts"))
      .then(() => true)
      .catch(() => false))
  );
  const escape = ".atelier/../escaped.md";
  await journal.markInProgress(escape);
  check(
    "a traversal out of .atelier is refused",
    !(await fs
      .stat(path.join(root, "escaped.md"))
      .then(() => true)
      .catch(() => false))
  );

  // A report with no plan and no changes must still read as a real entry.
  const bare = renderNoteReport({
    taskId: "task-3",
    status: "completed",
    request: "",
    intentKind: "question",
    intentSummary: "how does the cart work",
    planGoal: "",
    steps: [],
    changedFiles: [],
    validation: [],
    reviewVerdict: null,
    durationMs: 900,
    at: Date.UTC(2026, 6, 29, 13, 0),
    narrative: { issue: "Nothing was broken.", fix: "", flow: "" },
    assistantText: "",
  });
  check("an empty run still says so", bare.includes("_No files were changed._"));
  check(
    "a note run as-is says so instead of showing a blank request",
    bare.includes("no extra instructions were typed")
  );

  // The offline path, asserted directly rather than through a live call.
  const fallback = renderNoteReport({
    taskId: "task-4",
    status: "completed",
    request: "make it work",
    intentKind: "fix",
    intentSummary: "",
    planGoal: "",
    steps: [],
    changedFiles: ["src/cart/useTotal.ts"],
    validation: [],
    reviewVerdict: null,
    durationMs: 900,
    at: Date.UTC(2026, 6, 29, 13, 0),
    narrative: null,
    assistantText: "Added the discount code to the memo dependency list.",
  });
  check(
    "no narrative falls back to the agent's own answer",
    fallback.includes("### Summary (from the agent's own answer)") &&
      fallback.includes("Added the discount code to the memo dependency list.")
  );

  await fs.rm(root, { recursive: true, force: true });
  console.log(fail === 0 ? "\nall note cases pass" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
