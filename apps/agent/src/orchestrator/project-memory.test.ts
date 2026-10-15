import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  deleteMemory,
  listMemory,
  memorySlug,
  saveMemory,
} from "./project-memory.js";

test("workspace memory: save, edit, rename, delete, one file per fact", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-memory-"));
  try {
    assert.deepEqual(await listMemory(root), []);
    const saved = await saveMemory(root, {
      name: "No Redis locally",
      description: "Local runs\nhave no Redis",
      type: "correction",
      body: "KPIs come from snapshot + live only.",
    });
    assert.equal(saved.name, "no-redis-locally");
    // A description stays one line, so it cannot break the frontmatter.
    assert.equal(saved.description, "Local runs have no Redis");
    const file = path.join(root, ".atelier", "memory", "no-redis-locally.md");
    assert.match(fs.readFileSync(file, "utf8"), /^---\nname: no-redis-locally\n/);

    // A rename moves the file; no duplicate is left behind.
    await saveMemory(root, {
      name: "redis",
      previousName: "no-redis-locally",
      description: "Redis is off locally",
      type: "environment",
      body: "Still no Redis.",
    });
    const entries = await listMemory(root);
    assert.deepEqual(entries.map((e) => e.name), ["redis"]);
    assert.equal(entries[0]!.type, "environment");
    assert.equal(entries[0]!.body, "Still no Redis.");

    // A new entry cannot take an existing name.
    await assert.rejects(
      saveMemory(root, {
        name: "Redis",
        description: "x",
        type: "fact",
        body: "y",
      }),
      /already exists/
    );
    await deleteMemory(root, "redis");
    assert.deepEqual(await listMemory(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a memory name cannot reach outside the memory folder", () => {
  assert.equal(memorySlug("../../etc/passwd"), "etc-passwd");
  assert.throws(() => memorySlug("../"), /needs a name/);
});
