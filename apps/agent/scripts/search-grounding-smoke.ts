/**
 * Search-grounding smoke: unseen text terms are blocked until a tool
 * returns them, including in direct mode.
 *
 * Reproduces the observed failure — a turn asked to fix the chat timeline
 * searched a VS Code fork for "DIRECT EXECUTION" and "ACTIVE WORKFLOW",
 * two rule-heading-shaped phrases that exist nowhere in it — and pins the
 * grounding behaviour: known terms run, unknown terms return actionable
 * feedback, and repeating a blocked query does not bypass the guard.
 *
 *   pnpm --filter @atelier/agent smoke:grounding
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/storage/db.js";
import { EventBus } from "../src/events/event-bus.js";
import { HooksEngine } from "../src/hooks/hooks-engine.js";
import {
  SearchGroundingGuard,
  SEARCH_GROUNDING_HOOK_ID,
  SEARCH_GROUNDING_HOOK_NAME,
  SEARCH_GROUNDING_MATCHER,
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
    matcher: SEARCH_GROUNDING_MATCHER,
    action: "block",
    argument: "Search for words from the turn, not invented ones",
  });
  const guard = new SearchGroundingGuard(bus);
  hooks.registerGuard(SEARCH_GROUNDING_HOOK_ID, (ctx) => guard.check(ctx));

  const registry = new ToolRegistry(bus);
  registry.setGate(hooks);
  registry.register("search_text", async (input: unknown) => input);
  registry.register("retrieve_knowledge", async (input: unknown) => input);
  registry.register("read_file", async (input: unknown) => input);
  const abort = new AbortController();

  const notes: string[] = [];
  bus.subscribe((event) => {
    if (
      event.topic === "hook.completed" &&
      (event.payload as { hookId: string }).hookId === SEARCH_GROUNDING_HOOK_ID
    ) {
      notes.push((event.payload as { output?: string }).output ?? "");
    }
  });

  /**
   * True when a model-chosen query is blocked or noted as ungrounded.
   */
  const search = async (
    taskId: string,
    query: string,
    toolName = "search_text"
  ): Promise<boolean> => {
    const before = notes.length;
    try {
      await registry.run(toolName, { query }, taskId, abort.signal);
    } catch (error) {
      if (!String(error).includes("Blocked by hook")) throw error;
      return true;
    }
    return notes.length > before;
  };

  const task = "t-pipeline";
  guard.seed(task, [PROMPT, CONTEXT]);

  console.log("invented text terms are blocked");
  check(
    'blocks "DIRECT EXECUTION"',
    await search(task, "DIRECT EXECUTION")
  );
  check(
    'blocks "ACTIVE WORKFLOW"',
    await search(task, "ACTIVE WORKFLOW")
  );
  check(
    "retrieve_knowledge is noted too",
    await search(
      task,
      "real FinTrack app icon generated base64",
      "retrieve_knowledge"
    )
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
  check(
    "retrieve_knowledge allows a grounded request phrase",
    !(await search(task, "chatbox timeline", "retrieve_knowledge"))
  );

  console.log("\nrepeated searches do not bypass grounding");
  check(
    "the same unknown search remains blocked",
    await search(task, "DIRECT EXECUTION")
  );

  console.log("\nwhat tools return becomes searchable");
  check(
    "a symbol nobody mentioned is blocked first",
    await search(task, "ChatRequestParser")
  );
  guard.note(task, "export class ChatRequestParser { parse() {} }");
  check(
    "…and allowed once a tool has returned it",
    !(await search(task, "ChatRequestParser")),
    "seen in a tool result"
  );

  console.log("\nboundaries");
  const unseeded = "t-unseeded";
  check(
    "a turn with no vocabulary is not policed",
    !(await search(unseeded, "ANYTHING AT ALL"))
  );
  guard.seed("t-direct", [PROMPT]);
  check(
    "direct turns also require observed terms",
    await search("t-direct", "DIRECT EXECUTION")
  );
  guard.release("t-direct");

  console.log(
    `\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`
  );
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (failures > 0) process.exitCode = 1;
}

void main();
