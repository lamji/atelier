import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { listCliDocs } from "./cli-docs.js";

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-cli-docs-"));
  const dir = path.join(root, ".atelier", "doc-agent");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return root;
}

const REPORT = [
  "---",
  "id: 20261013-110223-login-flow",
  "session: conv_01ABC",
  "title: Login Flow",
  "---",
  "",
  "# Login Flow",
  "",
  "## Request",
  "Trace login.",
  "",
].join("\n");

test("lists reports with the session that wrote them", async () => {
  const root = workspace({ "20261013-110223-login-flow.md": REPORT });
  const docs = await listCliDocs(root);
  assert.equal(docs.length, 1);
  assert.deepEqual(
    { ...docs[0], createdAt: 0 },
    {
      id: "20261013-110223-login-flow",
      session: "conv_01ABC",
      title: "Login Flow",
      createdAt: 0,
      path: ".atelier/doc-agent/20261013-110223-login-flow.md",
      changedFiles: [],
      changedAt: 0,
    }
  );
});

test("reads a report saved with a byte-order mark and CRLF", async () => {
  const windows = `﻿${REPORT.replace(/\n/g, "\r\n")}`;
  const root = workspace({ "20261013-121622-google-login.md": windows });
  const [doc] = await listCliDocs(root);
  assert.equal(doc?.session, "conv_01ABC");
  assert.equal(doc?.title, "Login Flow");
});

test("a report with no usable session id belongs to no session", async () => {
  const root = workspace({
    "plain.md": "# Checkout\n\nNo frontmatter here.\n",
    "unknown.md": "---\nsession: unknown\n---\n# A\n",
    "literal.md": "---\nsession: ${CLAUDE_SESSION_ID}\n---\n# B\n",
    "notes.txt": "not a report",
  });
  const docs = await listCliDocs(root);
  assert.deepEqual(docs.map((doc) => doc.id).sort(), [
    "literal",
    "plain",
    "unknown",
  ]);
  assert.ok(docs.every((doc) => doc.session === null));
  assert.equal(docs.find((doc) => doc.id === "plain")?.title, "Checkout");
});

test("a workspace nobody has documented has no reports", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-cli-docs-"));
  assert.deepEqual(await listCliDocs(root), []);
});

/** Writes a workspace file and pins its last-write time, in seconds. */
function fileAt(root: string, rel: string, seconds: number, body = "x"): void {
  const file = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.utimesSync(file, seconds, seconds);
}

const CITING = [
  REPORT,
  "## Confirmed Flow",
  "1. submit - posts the form (`src/auth/login.ts:12`)",
  "2. open - starts the session (`src/auth/session.ts:40-52`)",
  "3. submit again (`src/auth/login.ts:30`)",
  "",
].join("\n");

test("a report is stale once a file it cites is written after it", async () => {
  const root = workspace({});
  const report = ".atelier/doc-agent/20261013-110223-login-flow.md";
  fileAt(root, "src/auth/session.ts", 1000);
  fileAt(root, report, 2000, CITING);
  fileAt(root, "src/auth/login.ts", 3000);
  const [doc] = await listCliDocs(root);
  assert.deepEqual(doc?.changedFiles, ["src/auth/login.ts"]);
  assert.equal(doc?.changedAt, 3000 * 1000);
});

test("a report newer than everything it cites is not stale", async () => {
  const root = workspace({});
  fileAt(root, "src/auth/session.ts", 1000);
  fileAt(root, "src/auth/login.ts", 1500);
  fileAt(root, ".atelier/doc-agent/login.md", 2000, CITING);
  const [doc] = await listCliDocs(root);
  assert.deepEqual(doc?.changedFiles, []);
  assert.equal(doc?.changedAt, 0);
});

test("a citation written with backslashes names the same file", async () => {
  const root = workspace({});
  const body = `${REPORT}1. submit (\`src\\auth\\login.ts:12\`)\n`;
  fileAt(root, ".atelier/doc-agent/login.md", 2000, body);
  fileAt(root, "src/auth/login.ts", 3000);
  const [doc] = await listCliDocs(root);
  assert.deepEqual(doc?.changedFiles, ["src/auth/login.ts"]);
});

test("only files inside the workspace can make a report stale", async () => {
  const root = workspace({});
  const outside = `${path.basename(root)}-outside.ts`;
  const body = [
    REPORT,
    `- leaves the workspace (\`../${outside}:1\`)`,
    "- was never there (`src/missing.ts:3`)",
    "- another report (`.atelier/doc-agent/other.md:1`)",
    "- a clock, not a file: 12:30",
    "",
  ].join("\n");
  fileAt(root, ".atelier/doc-agent/login.md", 2000, body);
  fileAt(root, ".atelier/doc-agent/other.md", 3000, "# Other\n");
  fileAt(path.dirname(root), outside, 3000);
  const docs = await listCliDocs(root);
  const doc = docs.find((item) => item.id === "login");
  assert.deepEqual(doc?.changedFiles, []);
  assert.equal(doc?.changedAt, 0);
});
