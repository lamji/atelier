import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { CliSessionDiffRepo } from "./cli-session-diffs.js";

const schema = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "schema.sql"
);

function change(path: string, at: number) {
  return {
    path,
    before: "a",
    after: "b",
    firstTouchedAt: at,
    lastTouchedAt: at,
    alsoTouchedBy: [],
  };
}

test("a committed file leaves the session's saved changes", () => {
  const db = new Database(":memory:");
  try {
    db.exec(readFileSync(schema, "utf8"));
    const diffs = new CliSessionDiffRepo(db);
    diffs.save("codex", "s1", [
      change("api/README.md", 1),
      change("api/src/routes.ts", 2),
    ]);
    diffs.save("codex", "s2", [change("api/README.md", 3)]);

    // Without the tree's state nothing is pruned on a guess.
    diffs.save("codex", "s1", []);
    assert.equal(diffs.get("codex", "s1").length, 2);

    // README.md was committed: only routes.ts is still dirty.
    diffs.save("codex", "s1", [], ["api/src/routes.ts", "web/app.tsx"]);
    assert.deepEqual(
      diffs.get("codex", "s1").map((c) => c.path),
      ["api/src/routes.ts"]
    );
    // Another session's saved changes are its own.
    assert.equal(diffs.get("codex", "s2").length, 1);
  } finally {
    db.close();
  }
});
