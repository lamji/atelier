import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  bundledSkillsRoot,
  listSlashCommands,
} from "../orchestrator/command-catalog.js";
import { cliSkillPaths } from "./cli-skills.js";

test("the atelier-init-feature skill is app-owned and saves under .atelier/doc-agent", () => {
  const file = path.join(bundledSkillsRoot(), "atelier-init-feature", "SKILL.md");
  const body = fs.readFileSync(file, "utf8");
  assert.match(body, /^---\r?\nname: atelier-init-feature\r?\n/);
  assert.match(body, /\.atelier\/doc-agent\//);
  // Nothing machine-specific may ship to another user's install.
  assert.doesNotMatch(body, /[A-Z]:\\|\/Users\/|\/home\//);
  const listed = listSlashCommands(os.tmpdir()).some(
    (command) => command.id === "app:skill:atelier-init-feature"
  );
  assert.ok(listed, "atelier-init-feature is listed as an app skill");
});

test("lists the CLI skills that ship beside the agent bundle", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-cli-skills-"));
  const skillDir = path.join(root, ".claude", "skills", "atelier-init-feature");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: atelier-init-feature\n---\n");
  // A folder without a SKILL.md is not a skill.
  fs.mkdirSync(path.join(root, ".claude", "skills", "empty"));

  assert.deepEqual(cliSkillPaths(root), {
    root,
    skills: [{ name: "atelier-init-feature", file: path.join(skillDir, "SKILL.md") }],
  });
});

test("reports no skills when the app ships none", () => {
  const missing = path.join(os.tmpdir(), "atelier-no-cli-skills");
  assert.deepEqual(cliSkillPaths(missing), { root: null, skills: [] });
});

test("the atelier-init-feature skill can bring an earlier report up to date", () => {
  const file = path.join(bundledSkillsRoot(), "atelier-init-feature", "SKILL.md");
  const body = fs.readFileSync(file, "utf8");
  // Atelier asks for this by itself when a cited file changes.
  assert.match(body, /update <doc-id>/);
  assert.match(body, /changed:/);
  // The rewrite is what tells Atelier the report has been checked.
  assert.match(body, /^\s+updated: /m);
  assert.match(body, /## Revisions/);
  assert.doesNotMatch(body, /never overwrite or edit an earlier report/);
});

function skillBody(name: string): string {
  const file = path.join(bundledSkillsRoot(), name, "SKILL.md");
  return fs.readFileSync(file, "utf8");
}

test("the atelier-re-init-feature skill reads reports back without changing them", () => {
  const body = skillBody("atelier-re-init-feature");
  assert.match(body, /^---\r?\nname: atelier-re-init-feature\r?\n/);
  assert.match(body, /\.atelier\/doc-agent\//);
  // This session's reports come first: they are what a compact took away.
  assert.match(body, /`session`/);
  assert.match(body, /Session: <id>/);
  assert.match(body, /\$\{CLAUDE_SESSION_ID\}/);
  // With nothing asked for it loads them rather than asking what to load.
  assert.match(body, /do not ask/i);
  // A report is a map, not the code: what it cites is checked before use.
  assert.match(body, /re-read/i);
  assert.match(body, /Do not edit, rewrite, or delete/);
  assert.doesNotMatch(body, /[A-Z]:\|\/Users\/|\/home\//);
  const listed = listSlashCommands(os.tmpdir()).some(
    (command) => command.id === "app:skill:atelier-re-init-feature"
  );
  assert.ok(listed, "atelier-re-init-feature is listed as an app skill");
});

test("both report skills ship to the provider CLIs", async () => {
  const script = new URL("../../scripts/copy-skills.mjs", import.meta.url);
  const { copySkills } = await import(script.href);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-copy-skills-"));
  copySkills(path.dirname(bundledSkillsRoot()), out);
  const shipped = cliSkillPaths(path.join(out, "cli-skills"))
    .skills.map((skill) => skill.name)
    .sort();
  assert.deepEqual(shipped, [
    "atelier-impact-check",
    "atelier-init-feature",
    "atelier-re-init-feature",
    "atelier-remember",
  ]);
  // The SessionStart hook ships beside them, inside the app.
  const hooks = fs.readdirSync(path.join(out, "cli-skills", "hooks")).sort();
  assert.deepEqual(hooks, [
    "codex-edit-impact.cmd",
    "codex-session-start.cmd",
    "codex-turn-end.cmd",
    "session-start.mjs",
    "turn-end.mjs",
  ]);
});

test("running document again on a flow rewrites its report, not a new file", () => {
  const body = skillBody("atelier-init-feature");
  assert.match(body, /One report per flow/);
  // The earlier report is found by the session that wrote it...
  assert.match(body, /whose `session` is this session's id/);
  // ...and by what it traces, since a rerun words its title differently.
  assert.match(body, /same trigger point/);
  assert.match(body, /Do not create a second file/);
  // The file keeps its name, so the Agents row keeps one entry for it.
  assert.match(body, /Keep its file name/);
  assert.doesNotMatch(body, /A new flow always\s+gets a new file/);
});

test("atelier-impact-check: read the impact before an edit, check it after the fix", () => {
  const body = skillBody("atelier-impact-check");
  assert.match(body, /^---\r?\nname: atelier-impact-check\r?\n/);
  // The hook supplies it before each edit; nobody has to run anything.
  assert.match(body, /before (every|each) edit/i);
  assert.match(body, /tree-sitter/);
  // After the fix: the diff check, in both shells the CLIs use.
  assert.match(body, /--diff/);
  assert.match(body, /"\$ATELIER_HOOK_NODE" "\$ATELIER_IMPACT_SCRIPT" --diff/);
  assert.match(body, /\$env:ATELIER_HOOK_NODE \$env:ATELIER_IMPACT_SCRIPT --diff/);
  assert.match(body, /run the tests/i);
  assert.doesNotMatch(body, /[A-Z]:\\|\/Users\/|\/home\//);
});

test("atelier-remember writes one memory entry and touches nothing else", () => {
  const body = skillBody("atelier-remember");
  assert.match(body, /^---\r?\nname: atelier-remember\r?\n/);
  assert.match(body, /\.atelier\/memory\//);
  // Same file format the hook and Settings read.
  assert.match(body, /description: <one line/);
  assert.match(body, /correction`/);
  // An existing entry is updated, never duplicated, and a broader entry
  // keeps the lines the new fact does not change.
  assert.match(body, /rewrite that file/);
  assert.match(body, /Never shrink an entry to the new\s+fact alone/);
  assert.match(body, /Do not change source code/);
  assert.match(body, /forget/);
});
