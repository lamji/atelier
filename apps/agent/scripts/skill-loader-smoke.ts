/**
 * Skill-loader smoke: skills load ONLY when the user types them as a leading
 * slash command, never by prompt matching, and never when disabled.
 *
 * Run: pnpm --filter @atelier/agent smoke:skills
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "../src/storage/db.js";
import { SettingsRepo } from "../src/storage/repositories/settings.js";
import { SkillLoader } from "../src/orchestrator/skill-loader.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-skills-smoke-"));

/**
 * In-memory Db stub. The native better-sqlite3 binding in this checkout is
 * built for the Electron ABI, so a smoke run under plain node cannot open a
 * real database. SettingsRepo only needs a `settings` table it can SELECT
 * empty (so the passed defaults apply), which this Map-backed stub provides.
 * Mirrors the pattern in scope-mention-smoke.ts.
 */
function memoryDb(): Db {
  return {
    prepare(sql: string) {
      if (sql.includes("SELECT")) {
        return {
          all: () => [],
          get: () => undefined,
          run: () => undefined,
        };
      }
      return { all: () => [], get: () => undefined, run: () => undefined };
    },
  } as unknown as Db;
}

function writeSkill(name: string, description: string, body: string): void {
  const dir = path.join(root, ".claude", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "---",
      "",
      body,
      "",
    ].join("\n")
  );
}

writeSkill(
  "atelier-smoke-angular",
  "Use for Angular component templates and reactive forms",
  "Prefer Angular component evidence, templates, ng-select, and formControlName checks."
);
writeSkill(
  "atelier-smoke-disabled-unique",
  "This disabled skill must never be loaded",
  "This body is intentionally an exact match for disabled loader testing."
);

const db = memoryDb();
const disabledId = "project:skill:atelier-smoke-disabled-unique";
const settings = new SettingsRepo(db, {
  workspaceRoot: root,
  ignoreGlobs: [],
  disabledSkills: [disabledId],
  globalSessionKnowledge: false,
  maxValidationRetries: 2,
  maxReviewRetries: 2,
});
const loader = new SkillLoader(root, settings);

const bundled = loader.load("/debugging fix the broken composer");
assert.deepEqual(
  bundled.skills.map((skill) => ({ id: skill.id, scope: skill.scope })),
  [{ id: "app:skill:debugging", scope: "app" }],
  "the bundled debugging skill should resolve before external skill folders"
);
assert.ok(
  bundled.context.includes("Ollama, Claude, and Codex"),
  "the bundled debugging skill should provide provider-neutral instructions"
);

const invoked = loader.load(
  "/atelier-smoke-angular fix the reactive form labels"
);
assert.deepEqual(
  invoked.skills.map((skill) => skill.name),
  ["atelier-smoke-angular"],
  "explicitly invoked skill should load"
);
assert.ok(
  invoked.context.includes("ATELIER INVOKED SKILLS"),
  "invoked skill should render provider context"
);

// The old router scored this prompt into the Angular skill; nothing may load
// now, because the user never asked for a skill.
const implicit = loader.load(
  "Fix Angular component template reactive forms with ng-select and formControlName"
);
assert.deepEqual(implicit.skills, [], "no skill may load without /invocation");
assert.equal(implicit.context, "", "no skill context without /invocation");

// A slash mid-prompt is prose (a route, a path), not an invocation.
const routeMention = loader.load(
  "the app redirects to /atelier-smoke-angular after login"
);
assert.deepEqual(
  routeMention.skills,
  [],
  "mid-prompt slash is not an invocation"
);

const disabled = loader.load("/atelier-smoke-disabled-unique run it anyway");
assert.deepEqual(disabled.skills, [], "disabled skill was loaded");

db.close?.();
fs.rmSync(root, { recursive: true, force: true });
console.log("skill-loader smoke: all checks passed");
