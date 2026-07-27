/**
 * Modularity guard smoke: verifies block/allow decisions.
 *
 *   pnpm --filter @atelier/agent smoke:modularity
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/storage/db.js";
import { EventBus } from "../src/events/event-bus.js";
import { HooksEngine } from "../src/hooks/hooks-engine.js";
import { ToolRegistry } from "../src/tools/registry.js";
import {
  ModularityGuard,
  MODULARITY_HOOK_ID,
  MODULARITY_HOOK_NAME,
} from "../src/hooks/modularity-guard.js";

const guard = new ModularityGuard();

interface Case {
  name: string;
  path: string;
  next: string;
  prev?: string;
  expectBlocked: boolean;
}

const CASES: Case[] = [
  {
    name: "two functions in one file -> BLOCK",
    path: "src/helpers/utils.ts",
    next: `export function formatDate(d: Date) { return d.toISOString(); }
export function parseDate(s: string) { return new Date(s); }`,
    expectBlocked: true,
  },
  {
    name: "single function -> allow",
    path: "src/helpers/formatDate.ts",
    next: `export function formatDate(d: Date) { return d.toISOString(); }`,
    expectBlocked: false,
  },
  {
    name: "two React components -> BLOCK",
    path: "src/views/Cards.tsx",
    next: `export function Card() { return <div />; }
export function CardList() { return <Card />; }`,
    expectBlocked: true,
  },
  {
    name: "component + types + constant -> allow",
    path: "src/views/Card.tsx",
    next: `export interface CardProps { title: string }
export const CARD_WIDTH = 320;
export function Card(props: CardProps) { return <div>{props.title}</div>; }`,
    expectBlocked: false,
  },
  {
    name: "arrow-function helpers grab-bag -> BLOCK",
    path: "src/lib/helpers.ts",
    next: `export const add = (a: number, b: number) => a + b;
export const sub = (a: number, b: number) => a - b;`,
    expectBlocked: true,
  },
  {
    name: "class with many methods -> allow (one class)",
    path: "src/services/GitService.ts",
    next: `export class GitService {
  commit() {}
  push() {}
  pull() {}
}`,
    expectBlocked: false,
  },
  {
    name: "editing a legacy multi-function file without growing it -> allow",
    path: "src/legacy/old-utils.ts",
    prev: `export function a() { return 1; }
export function b() { return 2; }
export function c() { return 3; }`,
    next: `export function a() { return 111; }
export function b() { return 2; }
export function c() { return 3; }`,
    expectBlocked: false,
  },
  {
    name: "adding a 4th function to a legacy file -> BLOCK",
    path: "src/legacy/old-utils.ts",
    prev: `export function a() { return 1; }
export function b() { return 2; }
export function c() { return 3; }`,
    next: `export function a() { return 1; }
export function b() { return 2; }
export function c() { return 3; }
export function d() { return 4; }`,
    expectBlocked: true,
  },
  {
    name: "barrel index.ts (re-exports only) -> allow",
    path: "src/helpers/index.ts",
    next: `export { formatDate } from "./formatDate.js";
export { parseDate } from "./parseDate.js";`,
    expectBlocked: false,
  },
  {
    name: "hook + component in one file -> BLOCK",
    path: "src/views/Widget.tsx",
    next: `export function useWidget() { return 1; }
export function Widget() { return <div /> }`,
    expectBlocked: true,
  },
  {
    name: "non-code file -> allow",
    path: "docs/notes.md",
    next: "# notes\nfunction-looking text function text",
    expectBlocked: false,
  },
];

/**
 * The rule is enforced in the write guard, which sees the content — the
 * hook entry only carries the on/off switch. Without a pass-through guard
 * the engine would apply its stored "block" action to every write, so this
 * checks the gate itself lets a compliant call through.
 */
async function checkGatePassesThrough(): Promise<boolean> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-modsmoke-"));
  const db = openDb(dataDir);
  const bus = new EventBus();
  const hooks = new HooksEngine(db, bus, process.cwd());
  hooks.ensureBuiltin({
    id: MODULARITY_HOOK_ID,
    name: MODULARITY_HOOK_NAME,
    enabled: true,
    event: "preTool",
    matcher: "write_file|replace_code",
    action: "block",
    argument: "One file = one function/component/class",
  });
  hooks.registerGuard(MODULARITY_HOOK_ID, async () => undefined);
  const registry = new ToolRegistry(bus);
  registry.setGate(hooks);
  registry.register("write_file", async (input: unknown) => input);

  let blocked = false;
  try {
    await registry.run(
      "write_file",
      { path: "src/helpers/formatDate.ts", content: "export function f() {}" },
      "t-mod",
      new AbortController().signal
    );
  } catch {
    blocked = true;
  }
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  return !blocked;
}

async function main(): Promise<void> {
  let failed = 0;
  for (const c of CASES) {
    const verdict = await guard.check(c.path, c.next, c.prev ?? "");
    const blocked = !verdict.ok;
    const pass = blocked === c.expectBlocked;
    if (!pass) failed += 1;
    console.log(`${pass ? "PASS" : "FAIL"}  ${c.name}`);
    if (!pass && !verdict.ok) console.log(`      reason: ${verdict.reason}`);
  }
  const gateOk = await checkGatePassesThrough();
  if (!gateOk) failed += 1;
  console.log(
    `${gateOk ? "PASS" : "FAIL"}  enabled hook does not block a compliant write`
  );
  console.log(failed === 0 ? "\nall cases pass" : `\n${failed} case(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
