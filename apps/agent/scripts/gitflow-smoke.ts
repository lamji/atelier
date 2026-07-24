/**
 * Git-flow hook smoke: the agent may not commit/push/PR by itself, while
 * read-only git and ordinary commands stay untouched. Also checks that the
 * block raises git.flow.requested so the UI can open the wizard.
 *
 *   pnpm --filter @atelier/agent smoke:gitflow
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/storage/db.js";
import { EventBus } from "../src/events/event-bus.js";
import { HooksEngine } from "../src/hooks/hooks-engine.js";
import {
  GitFlowGuard,
  GIT_FLOW_HOOK_ID,
  GIT_FLOW_HOOK_NAME,
} from "../src/hooks/git-flow-guard.js";
import { ToolRegistry } from "../src/tools/registry.js";

interface Case {
  name: string;
  tool: string;
  input: unknown;
  expectBlocked: boolean;
  /** Commit message the modal should be pre-filled with. */
  expectMessage?: string;
}

const CASES: Case[] = [
  {
    name: "git tool commit -> BLOCK",
    tool: "git",
    input: { action: "commit", message: "feat: add panel" },
    expectBlocked: true,
    expectMessage: "feat: add panel",
  },
  {
    name: "git tool status -> allow",
    tool: "git",
    input: { action: "status" },
    expectBlocked: false,
  },
  {
    name: "git tool stage -> allow",
    tool: "git",
    input: { action: "stage", paths: ["src/a.ts"] },
    expectBlocked: false,
  },
  {
    name: 'terminal: git commit -m "..." -> BLOCK',
    tool: "run_terminal",
    input: { command: 'git commit -m "fix: guard"' },
    expectBlocked: true,
    expectMessage: "fix: guard",
  },
  {
    name: "terminal: git add -A && git commit -m 'x' -> BLOCK",
    tool: "run_terminal",
    input: { command: "git add -A && git commit -m 'chore: bump'" },
    expectBlocked: true,
    expectMessage: "chore: bump",
  },
  {
    name: "terminal: git push -> BLOCK",
    tool: "run_terminal",
    input: { command: "git push -u origin feat/x" },
    expectBlocked: true,
  },
  {
    name: "terminal: gh pr create -> BLOCK",
    tool: "run_terminal",
    input: { command: 'gh pr create --base main --title "x" --body "y"' },
    expectBlocked: true,
  },
  {
    name: "terminal: git status -> allow",
    tool: "run_terminal",
    input: { command: "git status --short" },
    expectBlocked: false,
  },
  {
    name: "terminal: git diff / log -> allow",
    tool: "run_terminal",
    input: { command: "git log --oneline -n 5" },
    expectBlocked: false,
  },
  {
    name: "terminal: git checkout -b -> allow (wizard owns branching)",
    tool: "run_terminal",
    input: { command: "git checkout -b feat/x" },
    expectBlocked: false,
  },
  {
    name: "terminal: pnpm build -> allow",
    tool: "run_terminal",
    input: { command: "pnpm build" },
    expectBlocked: false,
  },
];

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-gfsmoke-"));
  const db = openDb(dataDir);
  const bus = new EventBus();
  const requests: Array<{ command: string; commitMessage?: string }> = [];
  bus.subscribe((e) => {
    if (e.topic === "git.flow.requested") {
      requests.push(e.payload as { command: string; commitMessage?: string });
    }
  });

  const hooks = new HooksEngine(db, bus, process.cwd());
  hooks.ensureBuiltin({
    id: GIT_FLOW_HOOK_ID,
    name: GIT_FLOW_HOOK_NAME,
    enabled: true,
    event: "preTool",
    matcher: "git|run_terminal",
    action: "block",
    argument: "Git flow must be confirmed by the user",
  });
  const guard = new GitFlowGuard(bus);
  hooks.registerGuard(GIT_FLOW_HOOK_ID, (ctx) => guard.check(ctx));

  const registry = new ToolRegistry(bus);
  registry.setGate(hooks);
  registry.register("git", async (input: unknown) => input);
  registry.register("run_terminal", async (input: unknown) => input);

  const abort = new AbortController();
  let fail = 0;
  const check = (name: string, ok: boolean, extra = "") => {
    if (!ok) fail += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  };

  for (const c of CASES) {
    const before = requests.length;
    let blocked = false;
    try {
      await registry.run(c.tool, c.input, "t-gf", abort.signal);
    } catch (error) {
      blocked = String(error).includes("Blocked by hook");
    }
    const raised = requests.length > before;
    const message = raised ? requests[requests.length - 1]?.commitMessage : undefined;
    const ok =
      blocked === c.expectBlocked &&
      raised === c.expectBlocked &&
      (c.expectMessage === undefined || message === c.expectMessage);
    check(c.name, ok, ok ? "" : `blocked=${blocked} raised=${raised} msg=${message}`);
  }

  // Disabling the hook in the panel restores the agent's own git flow.
  const builtin = hooks.list().find((h) => h.id === GIT_FLOW_HOOK_ID);
  if (builtin) hooks.save({ ...builtin, enabled: false });
  let blockedAfterDisable = false;
  try {
    await registry.run(
      "run_terminal",
      { command: 'git commit -m "x"' },
      "t-gf",
      abort.signal
    );
  } catch {
    blockedAfterDisable = true;
  }
  check("disabled hook no longer blocks", !blockedAfterDisable);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(fail === 0 ? "\nall git-flow cases pass" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
