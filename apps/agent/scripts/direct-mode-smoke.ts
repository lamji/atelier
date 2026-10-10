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
  EXECUTION_CHECKPOINT_MAX_CHARS,
  LIGHT_APPEND_CHARS,
  LIGHT_CONTEXT_MAX_CHARS,
  LIGHT_LAYOUT_CHARS,
  LIGHT_USER_RULE_CHARS,
  LIGHT_VIBE_CHARS,
  clipLightContext,
  isDirectMode,
  renderExecutionCheckpoint,
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
  check("every turn is one direct loop", isDirectMode({}) && isDirectMode({ systemKnowledge: true }));
  check("systemKnowledge: false is direct too", isDirectMode({ systemKnowledge: false }));
  process.env.ATELIER_FULL_PIPELINE = "1";
  check("legacy env cannot re-enable retrieval", isDirectMode({}));
  delete process.env.ATELIER_FULL_PIPELINE;
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
  check("rules describe the agent, not a mode", DIRECT_RULES.startsWith("ATELIER:"));
  check("rules promise no refusals", !/refus/i.test(DIRECT_RULES));
  check("rules keep the git-flow boundary", DIRECT_RULES.includes("Never commit"));
  check("rules keep approval modals", DIRECT_RULES.includes("approval modal"));
  check("rules keep workspace confinement", DIRECT_RULES.includes("active scope"));
}

function checkLightCompression(): void {
  const clipped = clipLightContext(`head\n\n\n${"x".repeat(2_000)}`, 120);
  check("light compression is local and bounded", clipped.length <= 120);
  check("clipped light context is explicit", clipped.endsWith("…"));
  check("redundant blank lines are compressed", !clipped.includes("\n\n\n"));
  check(
    "all light sections fit the hard context cap",
    DIRECT_RULES.length +
      LIGHT_LAYOUT_CHARS +
      LIGHT_USER_RULE_CHARS +
      LIGHT_APPEND_CHARS +
      LIGHT_VIBE_CHARS <=
      LIGHT_CONTEXT_MAX_CHARS
  );
}

function checkExecutionCheckpoint(): void {
  const checkpoint = renderExecutionCheckpoint({
    request: `fix timeline execution ${"request ".repeat(500)}`,
    outstanding: "Finish the implementation and verify the edited files.",
    goal: "Bound automated continuation context without losing execution state.",
    steps: [
      {
        title: "Gather the exact evidence",
        status: "done",
        files: ["apps/agent/src/orchestrator/pipeline-executor.ts"],
      },
      {
        title: "Apply the bounded continuation",
        status: "in-progress",
        files: ["apps/agent/src/orchestrator/direct-mode.ts"],
      },
      { title: "Run the narrow smoke test", status: "pending" },
    ],
    changedFiles: ["apps/agent/src/orchestrator/direct-mode.ts"],
  });
  check(
    "execution checkpoint is hard bounded",
    checkpoint.length <= EXECUTION_CHECKPOINT_MAX_CHARS
  );
  check("checkpoint keeps exact outstanding work", checkpoint.includes("Finish the implementation"));
  check("checkpoint keeps live plan state", checkpoint.includes("[in-progress] Apply the bounded continuation"));
  check("checkpoint keeps changed files", checkpoint.includes("apps/agent/src/orchestrator/direct-mode.ts"));
  check("checkpoint prevents broad reinvestigation", checkpoint.includes("Do not repeat broad investigation"));
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
  check(
    "full mode keeps the current executor contract and rules",
    source.includes("ATELIER_EXECUTOR_CONTRACT + FAST_RULES + userRules")
  );
  check(
    "Claude agent mode omits the SDK turn ceiling",
    source.includes("...(!direct ? { maxTurns: opts.maxTurns ?? claudeTurnBudget(purpose) } : {})")
  );
  check(
    "turn-limit continuation starts from a compact checkpoint",
    source.includes("const checkpoint = this.executionCheckpoint(ctx, prompt)") &&
      source.includes("resume: false")
  );
  check(
    "repeated gate retries do not resume the native transcript",
    source.includes("resume: !checkpointed")
  );
  // Continuity in light mode: the same provider-neutral block the pipeline
  // carries, the same working memory recorded, a local summary written.
  check(
    "every task runs through the turn runner",
    source.includes("await this.turns.run(ctx, (c, prompt, context, images) =>")
  );
  check(
    "a stopped turn is remembered as stopped",
    source.includes("this.turns.saveSummary(ctx, ctx.collectedText, status)")
  );
  check(
    "native tools ride beside the MCP tools",
    source.includes("...CLAUDE_NATIVE_TOOLS,") &&
      source.includes("hooks: this.nativeToolHooks(ctx),") &&
      source.includes("DISABLED_BUILTINS.filter((name) => !CLAUDE_NATIVE_TOOLS.some((native) => native === name))")
  );
  check(
    "native shell commands go through the user's run_terminal hooks",
    source.includes('"run_terminal",\n          { command },')
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
  check("only the last two ride", !rendered.includes("three"));
  check("older turns are omitted", !rendered.includes("one"));
  // The carried block is now built by SharedSessionContextBuilder within
  // its own token budget; the hard cap here is a backstop, and it must be
  // wide enough that a block the builder fitted is never cut a second time.
  check(
    "light append cap holds the builder's largest block",
    LIGHT_APPEND_CHARS >= 3200 * 4,
    `${LIGHT_APPEND_CHARS} chars`
  );
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
  checkLightCompression();
  checkExecutionCheckpoint();
  checkPipelineArmsGuards();
  checkTranscript();
  if (!process.argv.includes("--light-only")) await checkGuardBypass();

  console.log(fail === 0 ? "\nDirect-mode smoke OK" : `\n${fail} check(s) failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
