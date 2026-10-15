import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  deleteMemory,
  listMemory,
  memorySlug,
  rememberFact,
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

test("remember writes a fact with no model: name, type, update, forget", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-remember-"));
  try {
    const saved = await rememberFact(root, "no Redis in the local environment");
    assert.equal(saved.action, "saved");
    assert.ok(saved.action === "saved" && saved.entry);
    if (saved.action !== "saved") return;
    assert.equal(saved.entry.name, "no-redis-local-environment");
    assert.equal(saved.entry.type, "environment");
    assert.equal(saved.entry.description, "No Redis in the local environment");

    // The same subject again updates the entry instead of adding one.
    const again = await rememberFact(
      root,
      "no Redis in the local environment, it was removed in October"
    );
    assert.equal(again.action, "updated");
    assert.equal((await listMemory(root)).length, 1);

    const naming = await rememberFact(root, "Tiger means the finops-crystal-lens frontend");
    assert.ok(naming.action === "saved" && naming.entry.type === "naming");

    assert.deepEqual(await rememberFact(root, "forget zebra"), {
      action: "not-found",
      candidates: [],
    });
    const forgot = await rememberFact(root, "forget redis");
    assert.deepEqual(forgot, { action: "forgot", name: "no-redis-local-environment" });
    assert.equal((await listMemory(root)).length, 1);
    await assert.rejects(rememberFact(root, "   "), /Nothing to remember/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
