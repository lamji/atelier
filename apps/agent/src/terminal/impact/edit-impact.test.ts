import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { analyzeEdit, formatImpact } from "./edit-impact.js";

const MONEY = `export function formatMoney(cents: number): string {
  return "$" + (cents / 100).toFixed(2);
}

function roundCents(cents: number): number {
  return Math.round(cents);
}

export function total(items: number[]): string {
  return formatMoney(roundCents(items.reduce((a, b) => a + b, 0)));
}
`;
const RECEIPT = `import { formatMoney } from "./money";

export function buildReceipt(cents: number): string {
  return "Total: " + formatMoney(cents);
}
`;
const BUTTON = `import { formatMoney } from "../lib/money";
export const PriceTag = (props: { cents: number }) => {
  const show = formatMoney;
  return show(props.cents);
};
`;
const SPEC = `import { formatMoney } from "./money";
describe("money", () => {
  it("formats", () => {
    expect(formatMoney(100)).toBe("$1.00");
  });
});
`;
const UNRELATED = `// formatMoney is documented elsewhere.
export const label = "formatMoney";
export function slugify(s: string): string {
  return s.toLowerCase();
}
`;

/** A git repo shaped like a small app, committed so `git grep` sees it. */
function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-impact-"));
  const files: Record<string, string> = {
    "src/lib/money.ts": MONEY,
    "src/lib/receipt.ts": RECEIPT,
    "src/ui/PriceTag.tsx": BUTTON,
    "src/lib/money.test.ts": SPEC,
    "src/lib/unrelated.ts": UNRELATED,
    "README.md": "formatMoney(100) formats cents.\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return root;
}

test("an edit inside a function finds every place that uses it", async () => {
  const root = repo();
  const impact = await analyzeEdit({
    cwd: root,
    file: path.join(root, "src/lib/money.ts"),
    edits: ['return "$" + (cents / 100).toFixed(2);'],
  });
  assert.ok(impact);
  assert.deepEqual(
    impact.symbols.map((symbol) => symbol.name),
    ["formatMoney"]
  );
  const sites = impact.sites.map(
    (site) => `${site.file}:${site.line} ${site.kind} ${site.inside ?? "-"}`
  );
  assert.deepEqual(sites.sort(), [
    "src/lib/money.test.ts:1 import -",
    "src/lib/money.test.ts:4 call -",
    "src/lib/money.ts:10 call total",
    "src/lib/receipt.ts:1 import -",
    "src/lib/receipt.ts:4 call buildReceipt",
    "src/ui/PriceTag.tsx:1 import -",
    "src/ui/PriceTag.tsx:3 reference PriceTag",
  ]);
  // Comments, strings and prose that merely mention the name are not uses.
  assert.ok(!impact.sites.some((site) => site.file.includes("unrelated")));
  assert.ok(!impact.sites.some((site) => site.file === "README.md"));
  assert.deepEqual(impact.tests, ["src/lib/money.test.ts"]);
});

test("a private helper is only looked for in its own file", async () => {
  const root = repo();
  const impact = await analyzeEdit({
    cwd: root,
    file: path.join(root, "src/lib/money.ts"),
    edits: ["return Math.round(cents);"],
  });
  assert.deepEqual(
    impact?.symbols.map((symbol) => `${symbol.name}:${symbol.exported}`),
    ["roundCents:false"]
  );
  assert.deepEqual(
    impact?.sites.map((site) => `${site.file}:${site.line} ${site.inside}`),
    ["src/lib/money.ts:10 total"]
  );
});

test("rewriting a whole file covers everything it exports", async () => {
  const root = repo();
  const impact = await analyzeEdit({
    cwd: root,
    file: path.join(root, "src/lib/money.ts"),
    edits: null,
  });
  assert.deepEqual(
    impact?.symbols.map((symbol) => symbol.name).sort(),
    ["formatMoney", "total"]
  );
});

test("files tree-sitter cannot read, and new files, have no impact", async () => {
  const root = repo();
  const readme = await analyzeEdit({
    cwd: root,
    file: path.join(root, "README.md"),
    edits: ["formats"],
  });
  assert.equal(readme, null);
  const fresh = await analyzeEdit({
    cwd: root,
    file: path.join(root, "src/lib/new.ts"),
    edits: null,
  });
  assert.equal(fresh, null);
});

test("the report names each site and says what to do after the edit", async () => {
  const root = repo();
  const impact = await analyzeEdit({
    cwd: root,
    file: path.join(root, "src/lib/money.ts"),
    edits: ['return "$" + (cents / 100).toFixed(2);'],
  });
  const text = formatImpact(impact!);
  assert.match(text, /src\/lib\/money\.ts/);
  assert.match(text, /formatMoney \(function, exported, lines 1-3\)/);
  assert.match(text, /src\/lib\/receipt\.ts:4 .*buildReceipt/);
  assert.match(text, /Tests: src\/lib\/money\.test\.ts/);
  assert.match(text, /impact-check/);
});

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(here, "edit-impact-main.ts");
/** The loader by its own path: the child runs in a repo without tsx. */
const TSX = import.meta.resolve("tsx");

function runMain(
  args: string[],
  stdin: string,
  cwd: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", TSX, MAIN, ...args], {
      cwd,
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", () => resolve(out));
    child.stdin.end(stdin);
  });
}

test("Claude's PreToolUse: context for the agent, never a block", async () => {
  const root = repo();
  const event = {
    hook_event_name: "PreToolUse",
    session_id: "s1",
    cwd: root,
    tool_name: "Edit",
    tool_input: {
      file_path: path.join(root, "src", "lib", "money.ts"),
      old_string: 'return "$" + (cents / 100).toFixed(2);',
      new_string: 'return "USD " + (cents / 100).toFixed(2);',
    },
  };
  const out = await runMain(["claude"], JSON.stringify(event), root);
  const result = JSON.parse(out);
  assert.equal(result.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(result.hookSpecificOutput.additionalContext, /receipt\.ts:4/);
  // The edit goes ahead as the user's own permission settings decide.
  assert.equal(result.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(result.decision, undefined);
  const log = fs.readFileSync(path.join(root, ".atelier", "impact.log"), "utf8");
  assert.match(log, /"file":"src\/lib\/money\.ts"/);
  assert.match(log, /"symbols":\["formatMoney"\]/);
});

test("Codex's apply_patch: the files come out of the patch", async () => {
  const root = repo();
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/lib/money.ts",
    "@@",
    "-  return Math.round(cents);",
    "+  return Math.floor(cents);",
    "*** End Patch",
  ].join("\n");
  const event = {
    hook_event_name: "PreToolUse",
    cwd: root,
    tool_name: "apply_patch",
    tool_input: { input: patch },
  };
  const out = await runMain(["codex"], JSON.stringify(event), root);
  const result = JSON.parse(out);
  assert.match(result.hookSpecificOutput.additionalContext, /roundCents/);
  assert.match(result.hookSpecificOutput.additionalContext, /money\.ts:10/);
});

test("an edit with no code impact says nothing", async () => {
  const root = repo();
  const event = {
    cwd: root,
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "notes.md"), content: "x" },
  };
  assert.equal(await runMain(["claude"], JSON.stringify(event), root), "");
});

test("--diff: after the fix, the changed functions and their users", async () => {
  const root = repo();
  fs.writeFileSync(
    path.join(root, "src/lib/money.ts"),
    MONEY.replace("toFixed(2)", "toFixed(3)")
  );
  const out = await runMain(["--diff"], "", root);
  assert.match(out, /formatMoney/);
  assert.match(out, /src\/lib\/receipt\.ts:4/);
  assert.match(out, /Tests: src\/lib\/money\.test\.ts/);
});

test("Claude's PostToolUse: the code just written, and who uses it", async () => {
  const root = repo();
  const file = path.join(root, "src", "lib", "money.ts");
  const written = 'return "USD " + (cents / 100).toFixed(2);';
  fs.writeFileSync(file, MONEY.replace('return "$" + (cents / 100).toFixed(2);', written));
  const event = {
    hook_event_name: "PostToolUse",
    cwd: root,
    tool_name: "Edit",
    tool_input: { file_path: file, old_string: "gone", new_string: written },
  };
  const out = await runMain(["claude"], JSON.stringify(event), root);
  const result = JSON.parse(out);
  assert.equal(result.hookSpecificOutput.hookEventName, "PostToolUse");
  const context: string = result.hookSpecificOutput.additionalContext;
  assert.match(context, /after editing src\/lib\/money\.ts/);
  assert.match(context, /formatMoney/);
  assert.match(context, /receipt\.ts:4/);
  assert.match(context, /Re-check each site/);
  assert.equal(result.decision, undefined);
});

test("Codex's PostToolUse reads the lines the patch added", async () => {
  const root = repo();
  const file = path.join(root, "src", "lib", "money.ts");
  fs.writeFileSync(file, MONEY.replace("Math.round(cents)", "Math.floor(cents)"));
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/lib/money.ts",
    "-  return Math.round(cents);",
    "+  return Math.floor(cents);",
    "*** End Patch",
  ].join("\n");
  const event = {
    hook_event_name: "PostToolUse",
    cwd: root,
    tool_name: "apply_patch",
    tool_input: { input: patch },
  };
  const out = await runMain(["codex"], JSON.stringify(event), root);
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /roundCents/);
});
