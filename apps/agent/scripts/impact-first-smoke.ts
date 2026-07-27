/**
 * Impact-first hook smoke: an edit to an existing source file is refused
 * until the model has asked for that file's blast radius, and goes through
 * on the retry. New files, non-source files, and a fresh task are checked
 * too — the gate must not become a wall.
 *
 *   pnpm --filter @atelier/agent smoke:impact-first
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/storage/db.js";
import { EventBus } from "../src/events/event-bus.js";
import { HooksEngine } from "../src/hooks/hooks-engine.js";
import {
  ImpactFirstGuard,
  IMPACT_HOOK_ID,
  IMPACT_HOOK_NAME,
} from "../src/hooks/impact-guard.js";
import { ToolRegistry } from "../src/tools/registry.js";

/** Files that "exist" in the pretend workspace. */
const EXISTING = new Set([
  "src/pricing.ts",
  "src/panel.tsx",
  "docs/readme.md",
]);

interface Step {
  name: string;
  tool: string;
  input: unknown;
  taskId?: string;
  expectBlocked: boolean;
}

const STEPS: Step[] = [
  {
    name: "edit existing source with no radius -> BLOCK",
    tool: "replace_code",
    input: { path: "src/pricing.ts", oldString: "a", newString: "b" },
    expectBlocked: true,
  },
  {
    name: "impact_of_edit for that file -> allow",
    tool: "impact_of_edit",
    input: { path: "src/pricing.ts", line: 42 },
    expectBlocked: false,
  },
  {
    name: "same edit after the radius -> allow",
    tool: "replace_code",
    input: { path: "src/pricing.ts", oldString: "a", newString: "b" },
    expectBlocked: false,
  },
  {
    name: "second edit to the same file -> allow (asked once)",
    tool: "write_file",
    input: { path: "src/pricing.ts", content: "x" },
    expectBlocked: false,
  },
  {
    name: "path respelled ./src\\pricing.ts -> allow (normalized)",
    tool: "write_file",
    input: { path: "./src\\Pricing.ts", content: "x" },
    expectBlocked: false,
  },
  {
    name: "different existing file -> BLOCK (radius is per file)",
    tool: "write_file",
    input: { path: "src/panel.tsx", content: "x" },
    expectBlocked: true,
  },
  {
    name: "analyze_impact listing that file -> allow",
    tool: "analyze_impact",
    input: { files: ["src/panel.tsx"], depth: 1 },
    expectBlocked: false,
  },
  {
    name: "edit after analyze_impact -> allow",
    tool: "write_file",
    input: { path: "src/panel.tsx", content: "x" },
    expectBlocked: false,
  },
  {
    name: "new file -> allow (nothing can depend on it yet)",
    tool: "write_file",
    input: { path: "src/brand-new.ts", content: "x" },
    expectBlocked: false,
  },
  {
    name: "markdown -> allow (no symbols to trace)",
    tool: "write_file",
    input: { path: "docs/readme.md", content: "x" },
    expectBlocked: false,
  },
  {
    name: "same file in a NEW task -> BLOCK (ledger is per task)",
    tool: "write_file",
    input: { path: "src/pricing.ts", content: "x" },
    taskId: "t-impact-2",
    expectBlocked: true,
  },
];

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-ifsmoke-"));
  const db = openDb(dataDir);
  const bus = new EventBus();
  const blocks: Array<{ hookId: string; reason: string }> = [];
  bus.subscribe((e) => {
    if (e.topic === "hook.blocked") {
      blocks.push(e.payload as { hookId: string; reason: string });
    }
  });

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
  const guard = new ImpactFirstGuard(
    async (relPath) => EXISTING.has(relPath),
    bus
  );
  hooks.registerGuard(IMPACT_HOOK_ID, (ctx) => guard.check(ctx));

  const registry = new ToolRegistry(bus);
  registry.setGate(hooks);
  for (const name of [
    "write_file",
    "replace_code",
    "impact_of_edit",
    "analyze_impact",
  ]) {
    registry.register(name, async (input: unknown) => input);
  }

  const abort = new AbortController();
  let fail = 0;
  const check = (name: string, ok: boolean, extra = "") => {
    if (!ok) fail += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  };

  for (const step of STEPS) {
    const before = blocks.length;
    let blocked = false;
    try {
      await registry.run(
        step.tool,
        step.input,
        step.taskId ?? "t-impact-1",
        abort.signal
      );
    } catch (error) {
      blocked = String(error).includes("Blocked by hook");
    }
    const raised = blocks.length > before;
    const ok = blocked === step.expectBlocked && raised === step.expectBlocked;
    check(step.name, ok, ok ? "" : `blocked=${blocked} raised=${raised}`);
  }

  // The denial has to be actionable: it must name the tool and the file.
  const first = blocks[0]?.reason ?? "";
  check(
    "denial names impact_of_edit and the path",
    first.includes("impact_of_edit") && first.includes("src/pricing.ts"),
    first.slice(0, 80)
  );

  // Turning the hook off in the panel restores unguarded editing.
  const builtin = hooks.list().find((h) => h.id === IMPACT_HOOK_ID);
  if (builtin) hooks.save({ ...builtin, enabled: false });
  let blockedAfterDisable = false;
  try {
    await registry.run(
      "write_file",
      { path: "src/panel.tsx", content: "x" },
      "t-impact-3",
      abort.signal
    );
  } catch {
    blockedAfterDisable = true;
  }
  check("disabled hook no longer blocks", !blockedAfterDisable);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(fail === 0 ? "\nall impact-first cases pass" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
