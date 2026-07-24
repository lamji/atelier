/**
 * Database approval hook smoke: DB commands park until the user answers,
 * ordinary commands run untouched, and refusals cover deny / expiry /
 * task cancellation.
 *
 *   pnpm --filter @atelier/agent smoke:dbapproval
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/storage/db.js";
import { EventBus } from "../src/events/event-bus.js";
import { HooksEngine } from "../src/hooks/hooks-engine.js";
import {
  DbApprovalGuard,
  DB_APPROVAL_HOOK_ID,
  DB_APPROVAL_HOOK_NAME,
} from "../src/hooks/db-approval-guard.js";
import { ToolRegistry } from "../src/tools/registry.js";

const DB_COMMANDS = [
  'psql -h localhost -c "select 1"',
  "pnpm prisma migrate deploy",
  "npx drizzle-kit push",
  "pnpm run db:seed",
  "mysqldump app > backup.sql",
  "supabase db reset",
  'wrangler d1 execute app --command "DELETE FROM users"',
  'sqlite3 app.db "DROP TABLE sessions"',
];

const SAFE_COMMANDS = [
  "pnpm build",
  "pnpm typecheck",
  'rg "DELETE FROM users" src',
  "git status --short",
  "node scripts/report.mjs",
];

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-dbsmoke-"));
  const db = openDb(dataDir);
  const bus = new EventBus();
  const requested: Array<{ id: string; operation: string }> = [];
  const resolved: Array<{ id: string; outcome: string }> = [];
  bus.subscribe((e) => {
    if (e.topic === "db.approval.requested") {
      requested.push(e.payload as { id: string; operation: string });
    }
    if (e.topic === "db.approval.resolved") {
      resolved.push(e.payload as { id: string; outcome: string });
    }
  });

  const hooks = new HooksEngine(db, bus, process.cwd());
  hooks.ensureBuiltin({
    id: DB_APPROVAL_HOOK_ID,
    name: DB_APPROVAL_HOOK_NAME,
    enabled: true,
    event: "preTool",
    matcher: "run_terminal",
    action: "block",
    argument: "Database operations need the user's approval",
  });
  const guard = new DbApprovalGuard(bus);
  hooks.registerGuard(DB_APPROVAL_HOOK_ID, (ctx) => guard.check(ctx));

  const registry = new ToolRegistry(bus);
  registry.setGate(hooks);
  let ran = 0;
  registry.register("run_terminal", async (input: unknown) => {
    ran += 1;
    return input;
  });

  let fail = 0;
  const check = (name: string, ok: boolean, extra = "") => {
    if (!ok) fail += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  };

  /** Runs a command and answers the approval it raises, if any. */
  const runWithAnswer = async (
    command: string,
    approve: boolean | null,
    signal: AbortSignal
  ): Promise<{ parked: boolean; blocked: boolean }> => {
    const before = requested.length;
    const call = registry
      .run("run_terminal", { command }, "t-db", signal)
      .then(() => false)
      .catch((error: unknown) => String(error).includes("Blocked by hook"));
    // Give the guard a tick to park the call and publish its request.
    await new Promise((r) => setTimeout(r, 20));
    const parked = requested.length > before;
    if (parked && approve !== null) {
      guard.resolve(requested[requested.length - 1]!.id, approve);
    }
    return { parked, blocked: await call };
  };

  const abort = new AbortController();

  // 1. Every DB command parks and runs only once approved.
  for (const command of DB_COMMANDS) {
    const before = ran;
    const { parked, blocked } = await runWithAnswer(command, true, abort.signal);
    check(
      `parks + approves: ${command.slice(0, 46)}`,
      parked && !blocked && ran === before + 1,
      `parked=${parked} blocked=${blocked}`
    );
  }

  // 2. Ordinary commands are never held.
  for (const command of SAFE_COMMANDS) {
    const before = ran;
    const { parked, blocked } = await runWithAnswer(command, null, abort.signal);
    check(
      `runs untouched: ${command.slice(0, 46)}`,
      !parked && !blocked && ran === before + 1,
      `parked=${parked} blocked=${blocked}`
    );
  }

  // 3. Deny refuses the call and the command never runs.
  const beforeDenied = ran;
  const denied = await runWithAnswer("psql -c 'drop table users'", false, abort.signal);
  check(
    "deny blocks the command",
    denied.parked && denied.blocked && ran === beforeDenied,
    `blocked=${denied.blocked} ran=${ran - beforeDenied}`
  );

  // 4. Cancelling the task stops the wait and refuses.
  const cancel = new AbortController();
  const cancelled = registry
    .run("run_terminal", { command: "pnpm prisma migrate dev" }, "t-db", cancel.signal)
    .then(() => false)
    .catch((error: unknown) => String(error).includes("Blocked by hook"));
  await new Promise((r) => setTimeout(r, 20));
  cancel.abort();
  check("cancelled task stops waiting", await cancelled);
  check(
    "cancellation reported as an outcome",
    resolved.some((r) => r.outcome === "cancelled"),
    resolved.map((r) => r.outcome).join(",")
  );

  // 5. Answering twice is a no-op the UI can report.
  const stale = guard.resolve("dbapp-does-not-exist", true);
  check("resolving an unknown id returns false", stale === false);

  // 6. Disabling the hook in the panel restores unattended DB work.
  const builtin = hooks.list().find((h) => h.id === DB_APPROVAL_HOOK_ID);
  if (builtin) hooks.save({ ...builtin, enabled: false });
  const beforeOff = ran;
  const off = await runWithAnswer("pnpm prisma migrate deploy", null, abort.signal);
  check(
    "disabled hook no longer parks",
    !off.parked && !off.blocked && ran === beforeOff + 1
  );

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(fail === 0 ? "\nall db approval cases pass" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
