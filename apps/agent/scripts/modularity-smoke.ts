/**
 * Modularity guard smoke: verifies block/allow decisions.
 *
 *   pnpm --filter @atelier/agent smoke:modularity
 */
import { ModularityGuard } from "../src/hooks/modularity-guard.js";

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
  console.log(failed === 0 ? "\nall cases pass" : `\n${failed} case(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
