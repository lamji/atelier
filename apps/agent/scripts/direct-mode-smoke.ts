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
  TargetedEditGuard,
  REWRITE_HOOK_ID,
  REWRITE_HOOK_NAME,
} from "../src/hooks/rewrite-guard.js";
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
  check(
    "pipeline rules state the impact radius block",
    FAST_RULES.includes("IMPACT RADIUS")
  );
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

/**
 * The targeted-edit guard, wired the way the runtime wires it.
 *
 * It used to be the impact guard here — that hook is gone (the radius is
 * computed in the pipeline and shipped as context), so the bypass is
 * demonstrated on the remaining per-task guard. The property under test is
 * the bypass itself, not which guard implements it.
 */
async function checkGuardBypass(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-directsmoke-"));
  const db = openDb(dataDir);
  const bus = new EventBus();
  const hooks = new HooksEngine(db, bus, process.cwd());
  hooks.ensureBuiltin({
    id: REWRITE_HOOK_ID,
    name: REWRITE_HOOK_NAME,
    enabled: true,
    event: "preTool",
    matcher: "write_file",
    action: "block",
    argument: "Patch with replace_code instead of rewriting the whole file",
  });
  const directTasks = new DirectTaskRegistry();
  // A long file whose "rewrite" keeps every line — a patch in disguise,
  // which is exactly what the guard refuses.
  const existing = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
  const guard = new TargetedEditGuard(async () => existing, bus);
  hooks.registerGuard(REWRITE_HOOK_ID, (ctx) =>
    directTasks.has(ctx.taskId)
      ? Promise.resolve(undefined)
      : guard.check(ctx)
  );

  const registry = new ToolRegistry(bus);
  registry.setGate(hooks);
  registry.register("write_file", async (input: unknown) => input);
  const abort = new AbortController();

  const edit = async (taskId: string): Promise<boolean> => {
    try {
      await registry.run(
        "write_file",
        { path: `src/pricing-${taskId}.ts`, content: `${existing}\nline 60` },
        taskId,
        abort.signal
      );
      return false;
    } catch (error) {
      return String(error).includes("Blocked by hook");
    }
  };

  check("pipeline task is held to targeted edits", await edit("t-pipeline"));
  directTasks.mark("t-direct");
  check("direct task rewrites without a refusal", !(await edit("t-direct")));
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
