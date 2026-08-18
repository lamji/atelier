/**
 * Direct-mode smoke: the "System knowledge" checkbox, unticked.
 *
 * Offline checks only — no model, no index. What it protects:
 * the flag's semantics (absent = pipeline), a tool surface with no
 * knowledge tools on it that still names real tools, rules that no longer
 * describe machinery the turn does not have, the code guards standing down
 * for a direct task and only for its lifetime, and a plain conversation
 * transcript in place of session memory.
 *
 *   pnpm --filter @atelier/agent smoke:direct
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/storage/db.js";
import { EventBus } from "../src/events/event-bus.js";
import { HooksEngine } from "../src/hooks/hooks-engine.js";
import { DirectTaskRegistry } from "../src/hooks/direct-tasks.js";
import {
  ImpactFirstGuard,
  IMPACT_HOOK_ID,
  IMPACT_HOOK_NAME,
} from "../src/hooks/impact-guard.js";
import { ToolRegistry } from "../src/tools/registry.js";
import {
  DIRECT_RULES,
  DIRECT_TOOLS,
  isDirectMode,
  renderPriorTurns,
} from "../src/orchestrator/direct-mode.js";
import { FAST_RULES } from "../src/orchestrator/pipeline-executor.js";

/** Tools that exist only because the knowledge engine does. */
const KNOWLEDGE_TOOLS = [
  "retrieve_knowledge",
  "query_knowledge_graph",
  "search_symbols",
  "impact_of_edit",
  "analyze_impact",
  "update_plan_step",
  "save_lesson",
];

let fail = 0;

function check(name: string, ok: boolean, extra = ""): void {
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
}

/** Tool names the in-process MCP server actually exposes to the model. */
function sdkToolNames(): Set<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(
    path.join(here, "../src/orchestrator/sdk-tools.ts"),
    "utf8"
  );
  const names = new Set<string>();
  for (const match of source.matchAll(/\n\s*tool\(\s*\n\s*"([a-z_]+)"/g)) {
    if (match[1]) names.add(match[1]);
  }
  return names;
}

function checkFlag(): void {
  check("absent flag runs the pipeline", !isDirectMode({}));
  check("systemKnowledge: true runs the pipeline", !isDirectMode({ systemKnowledge: true }));
  check("systemKnowledge: false is direct", isDirectMode({ systemKnowledge: false }));
}

function checkTools(): void {
  const offered = new Set(DIRECT_TOOLS);
  const leaked = KNOWLEDGE_TOOLS.filter((name) => offered.has(name));
  check("no knowledge tool is offered", leaked.length === 0, leaked.join(", "));
  for (const name of ["read_file", "write_file", "replace_code", "search_text", "run_terminal"]) {
    check(`${name} is still offered`, offered.has(name));
  }
  const real = sdkToolNames();
  check("the SDK tool list was parsed", real.size > 5, `${real.size} tools`);
  const unknown = DIRECT_TOOLS.filter((name) => !real.has(name));
  check("every direct tool is a real tool", unknown.length === 0, unknown.join(", "));
}

function checkRules(): void {
  for (const phrase of ["retrieve_knowledge", "impact_of_edit", "MODULARITY", "PLAN PROGRESS"]) {
    check(
      `rules no longer mention ${phrase}`,
      !DIRECT_RULES.includes(phrase)
    );
  }
  check("rules keep the git-flow gate", DIRECT_RULES.includes("GIT FLOW RULE"));
  check("rules keep the DB approval gate", DIRECT_RULES.includes("DATABASE RULE"));
  check(
    "rules keep workspace confinement",
    DIRECT_RULES.includes("STRICT WORKSPACE CONFINEMENT")
  );
}

/**
 * The pair that broke once already: the bypass must belong to direct mode
 * alone, and the rule the re-armed hook enforces must be in the block the
 * pipeline actually sends. Marking every pipeline task direct silently
 * disarmed the impact hook for all four providers, and no test noticed
 * because the guard itself still passed in isolation.
 */
function checkPipelineArmsGuards(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(
    path.join(here, "../src/orchestrator/pipeline-executor.ts"),
    "utf8"
  );
  const marks = source.match(/this\.deps\.directTasks\.mark\(/g) ?? [];
  check(
    "only direct mode bypasses the code guards",
    marks.length === 1,
    `${marks.length} mark() call(s)`
  );
  check("pipeline rules state the impact hook", FAST_RULES.includes("impact_of_edit"));
  check(
    "pipeline rules state the targeted-edit hook",
    FAST_RULES.includes("replace_code")
  );
}

function checkTranscript(): void {
  check("no history renders as nothing", renderPriorTurns([]) === "");
  const turns: Array<{ role: "user" | "assistant"; text: string }> = [
    { role: "user", text: "one" },
    { role: "assistant", text: "two" },
    { role: "user", text: "three" },
    { role: "assistant", text: "four" },
    { role: "user", text: "five" },
  ];
  const rendered = renderPriorTurns(turns);
  check("recent turns ride verbatim", rendered.includes("User: five"));
  check("only the last four ride", !rendered.includes("one"));
}

/** The impact guard, wired the way main.ts wires it. */
async function checkGuardBypass(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-directsmoke-"));
  const db = openDb(dataDir);
  const bus = new EventBus();
  const hooks = new HooksEngine(db, bus, process.cwd());
  hooks.ensureBuiltin({
    id: IMPACT_HOOK_ID,
    name: IMPACT_HOOK_NAME,
    enabled: true,
    event: "preTool",
    matcher: "write_file|replace_code|impact_of_edit|analyze_impact",
    action: "block",
    argument: "Check who uses this code before editing it",
  });
  const directTasks = new DirectTaskRegistry();
  const guard = new ImpactFirstGuard(async () => true, bus);
  hooks.registerGuard(IMPACT_HOOK_ID, (ctx) =>
    directTasks.has(ctx.taskId)
      ? Promise.resolve(undefined)
      : guard.check(ctx)
  );

  const registry = new ToolRegistry(bus);
  registry.setGate(hooks);
  registry.register("replace_code", async (input: unknown) => input);
  const abort = new AbortController();

  const edit = async (taskId: string): Promise<boolean> => {
    try {
      await registry.run(
        "replace_code",
        { path: "src/pricing.ts", oldString: "a", newString: "b" },
        taskId,
        abort.signal
      );
      return false;
    } catch (error) {
      return String(error).includes("Blocked by hook");
    }
  };

  check("pipeline task still needs a radius first", await edit("t-pipeline"));
  directTasks.mark("t-direct");
  check("direct task edits without one", !(await edit("t-direct")));
  directTasks.release("t-direct");
  check("the bypass ends with the task", await edit("t-direct"));

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  checkFlag();
  checkTools();
  checkRules();
  checkPipelineArmsGuards();
  checkTranscript();
  await checkGuardBypass();

  console.log(fail === 0 ? "\nDirect-mode smoke OK" : `\n${fail} check(s) failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
