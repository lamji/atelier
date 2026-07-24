/**
 * Hooks engine smoke: user hooks gate tool calls (block, pathGlob,
 * runCommand). In-process, no SDK needed.
 *
 *   pnpm --filter @atelier/agent smoke:hooks
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/storage/db.js";
import { EventBus } from "../src/events/event-bus.js";
import { HooksEngine } from "../src/hooks/hooks-engine.js";
import { ToolRegistry } from "../src/tools/registry.js";

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-hsmoke-"));
  const db = openDb(dataDir);
  const bus = new EventBus();
  const events: string[] = [];
  bus.subscribe((e) => {
    if (e.topic.startsWith("hook.")) events.push(e.topic);
  });

  const hooks = new HooksEngine(db, bus, process.cwd());
  const registry = new ToolRegistry(bus);
  registry.setGate(hooks);
  registry.register("write_file", async (input: { path: string }) => ({
    wrote: input.path,
  }));

  hooks.save({
    id: "user-env-guard",
    name: "Protect env files",
    enabled: true,
    event: "preTool",
    matcher: "write_file|replace_code",
    pathGlob: "**/*.env",
    action: "block",
    argument: "Env files are user-managed; never write them.",
  });

  const abort = new AbortController();
  let pass = 0;
  let fail = 0;
  const check = (name: string, ok: boolean, extra = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
    ok ? pass++ : fail++;
  };

  // 1. Blocked path.
  try {
    await registry.run("write_file", { path: "config/prod.env" }, "t1", abort.signal);
    check("hook blocks write to **/*.env", false);
  } catch (error) {
    check(
      "hook blocks write to **/*.env",
      String(error).includes("Blocked by hook"),
      String(error).slice(0, 80)
    );
  }

  // 2. Non-matching path passes.
  const ok = (await registry.run(
    "write_file",
    { path: "src/app.ts" },
    "t2",
    abort.signal
  )) as { wrote: string };
  check("non-matching path allowed", ok.wrote === "src/app.ts");

  // 3. Disabled hook stops blocking.
  hooks.save({
    id: "user-env-guard",
    name: "Protect env files",
    enabled: false,
    event: "preTool",
    matcher: "write_file|replace_code",
    pathGlob: "**/*.env",
    action: "block",
    argument: "n/a",
  });
  const after = (await registry.run(
    "write_file",
    { path: "config/prod.env" },
    "t3",
    abort.signal
  )) as { wrote: string };
  check("disabled hook no longer blocks", after.wrote === "config/prod.env");

  // 4. runCommand hook: failing command blocks.
  hooks.save({
    id: "user-cmd-gate",
    name: "Command gate",
    enabled: true,
    event: "preTool",
    matcher: "write_file",
    action: "runCommand",
    argument: "exit 1",
  });
  try {
    await registry.run("write_file", { path: "src/x.ts" }, "t4", abort.signal);
    check("failing runCommand blocks", false);
  } catch (error) {
    check(
      "failing runCommand blocks",
      String(error).includes("Blocked by hook")
    );
  }

  // 5. preTask hook blocks a matching prompt.
  hooks.save({
    id: "user-notouch",
    name: "No deletions",
    enabled: true,
    event: "preTask",
    matcher: "delete everything",
    action: "block",
    argument: "Mass deletion prompts are refused.",
  });
  const decision = await hooks.evaluatePreTask("please delete everything", "t5");
  check("preTask hook blocks matching prompt", decision.allowed === false);

  check(
    "hook events published",
    events.includes("hook.matched") && events.includes("hook.blocked"),
    events.join(",")
  );

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(fail === 0 ? "\nall hook cases pass" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
