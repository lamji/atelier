/**
 * Search-grounding smoke: the model may not grep for terms it made up.
 *
 * Reproduces the observed failure — a turn asked to fix the chat timeline
 * searched a VS Code fork for "DIRECT EXECUTION" and "ACTIVE WORKFLOW",
 * two rule-heading-shaped phrases that exist nowhere in it — and pins the
 * behaviour that replaced it.
 *
 *   pnpm --filter @atelier/agent smoke:grounding
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/storage/db.js";
import { EventBus } from "../src/events/event-bus.js";
import { HooksEngine } from "../src/hooks/hooks-engine.js";
import { DirectTaskRegistry } from "../src/hooks/direct-tasks.js";
import {
  SearchGroundingGuard,
  SEARCH_GROUNDING_HOOK_ID,
  SEARCH_GROUNDING_HOOK_NAME,
} from "../src/hooks/search-grounding-guard.js";
import { ToolRegistry } from "../src/tools/registry.js";

/** The turn as the model received it: request + assembled context. */
const PROMPT = "fix and redesign the timeline execution in the chatbox";
const CONTEXT = [
  "DIRECTORY MAP — src/ (real paths in this project)",
  "  vs/workbench/contrib/chat/browser/  chatWidget.ts chatListRenderer.ts",
  "KNOWLEDGE: chatWidget.ts renders the chat surface and its request rows.",
].join("\n");

let failures = 0;

function check(name: string, ok: boolean, extra = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
}

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-grounding-"));
  const db = openDb(dataDir);
  const bus = new EventBus();
  const hooks = new HooksEngine(db, bus, process.cwd());
  hooks.ensureBuiltin({
    id: SEARCH_GROUNDING_HOOK_ID,
    name: SEARCH_GROUNDING_HOOK_NAME,
    enabled: true,
    event: "preTool",
    matcher: "search_text|search_workspace",
    action: "block",
    argument: "Search for words from the turn, not invented ones",
  });
  const directTasks = new DirectTaskRegistry();
  const guard = new SearchGroundingGuard(bus);
  hooks.registerGuard(SEARCH_GROUNDING_HOOK_ID, (ctx) =>
    directTasks.has(ctx.taskId)
      ? Promise.resolve(undefined)
      : guard.check(ctx)
  );

  const registry = new ToolRegistry(bus);
  registry.setGate(hooks);
  registry.register("search_text", async (input: unknown) => input);
  registry.register("read_file", async (input: unknown) => input);
  const abort = new AbortController();

  /** Runs a search; true when the hook refused it. */
  const search = async (taskId: string, query: string): Promise<boolean> => {
    try {
      await registry.run("search_text", { query }, taskId, abort.signal);
      return false;
    } catch (error) {
      return String(error).includes("Blocked by hook");
    }
  };

  const task = "t-pipeline";
  guard.seed(task, [PROMPT, CONTEXT]);

  console.log("invented terms");
  check(
    'refuses "DIRECT EXECUTION"',
    await search(task, "DIRECT EXECUTION")
  );
  check(
    'refuses "ACTIVE WORKFLOW"',
    await search(task, "ACTIVE WORKFLOW")
  );

  console.log("\ngrounded terms");
  check("allows a word the user used", !(await search(task, "timeline")));
  check(
    "allows a phrase from the request",
    !(await search(task, "chatbox timeline"))
  );
  check(
    "allows a file name from the directory map",
    !(await search(task, "chatListRenderer"))
  );

  console.log("\nit is a speed bump, not a wall");
  check(
    "the same invented search goes through on the retry",
    !(await search(task, "DIRECT EXECUTION"))
  );

  console.log("\nwhat tools return becomes searchable");
  check(
    "a symbol nobody mentioned is refused first",
    await search(task, "ChatRequestParser")
  );
  guard.note(task, "export class ChatRequestParser { parse() {} }");
  check(
    "…and allowed once a tool has returned it",
    !(await search("t-second", "ChatRequestParser")) ||
      !(await search(task, "ChatRequestParser")),
    "seen in a tool result"
  );

  console.log("\nboundaries");
  const unseeded = "t-unseeded";
  check(
    "a turn with no vocabulary is not policed",
    !(await search(unseeded, "ANYTHING AT ALL"))
  );
  directTasks.mark("t-direct");
  guard.seed("t-direct", [PROMPT]);
  check(
    "system-knowledge-off turns are not policed",
    !(await search("t-direct", "DIRECT EXECUTION"))
  );
  directTasks.release("t-direct");

  console.log(
    `\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`
  );
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (failures > 0) process.exitCode = 1;
}

void main();
