/**
 * User-rules smoke: Markdown rules open as ordinary workspace files and
 * enabled rule bodies are read fresh for every new agent session.
 *
 *   pnpm --filter @atelier/agent smoke:rules
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createUserRule,
  listUserRules,
  setUserRuleEnabled,
  userRulesPrompt,
} from "../src/orchestrator/user-rules.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-user-rules-"));

try {
  const created = await createUserRule(root, "Commit style");
  assert.equal(created.path, ".atelier/rules/Commit style.md");
  assert.equal(created.enabled, true);

  const file = path.join(root, created.path);
  const template = await fs.readFile(file, "utf8");
  assert.match(template, /^---\nenabled: true\n---\n\n# Commit style/m);

  await fs.writeFile(
    file,
    "---\nenabled: true\n---\n\n# Commit style\n\nUse imperative commit subjects.\n",
    "utf8"
  );
  const firstSession = await userRulesPrompt(root);
  assert.match(firstSession, /USER RULES/);
  assert.match(firstSession, /Use imperative commit subjects\./);

  // A new session reads the Markdown again; it never needs an app restart.
  await fs.writeFile(
    file,
    "---\nenabled: true\n---\n\n# Commit style\n\nKeep commit subjects under 72 characters.\n",
    "utf8"
  );
  const nextSession = await userRulesPrompt(root);
  assert.doesNotMatch(nextSession, /Use imperative commit subjects\./);
  assert.match(nextSession, /Keep commit subjects under 72 characters\./);

  await setUserRuleEnabled(root, created.path, false);
  assert.equal(await userRulesPrompt(root), "");

  await setUserRuleEnabled(root, created.path, true);
  assert.match(
    await userRulesPrompt(root),
    /Keep commit subjects under 72 characters\./
  );

  // Markdown copied into the folder by hand is enabled by default.
  await fs.writeFile(
    path.join(root, ".atelier", "rules", "testing.md"),
    "# Testing\n\nRun the narrow test before reporting.\n",
    "utf8"
  );
  const rules = await listUserRules(root);
  assert.equal(rules.length, 2);
  assert.equal(rules.find((rule) => rule.title === "Testing")?.enabled, true);
  assert.match(
    await userRulesPrompt(root),
    /Run the narrow test before reporting\./
  );

  console.log("user-rules smoke passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
