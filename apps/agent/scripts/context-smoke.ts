/**
 * Context-engineering smoke: token helpers, tool-output shapers, and the
 * TokenLedger round-trip (insert → attach SDK usage → query + event).
 * Run: pnpm --filter @atelier/agent smoke:context
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { approxTokens, clipToTokens } from "@atelier/shared";
import type { RetrievedChunk } from "@atelier/protocol";
import { shapeToolOutput } from "../src/context/tool-output/index.js";
import { TokenLedger } from "../src/context/ledger/index.js";
import { PromptAssembler } from "../src/context/assemble/index.js";
import { dedupeAndDiversify } from "../src/context/rank/index.js";
import { budgetFor } from "../src/context/budget/index.js";
import {
  CachedRetriever,
  IndexGeneration,
} from "../src/context/cache/index.js";
import { SentChunkStore } from "../src/context/dedup/index.js";
import {
  buildTaskSummary,
  TaskSummaryStore,
} from "../src/context/summaries/index.js";
import { openDb } from "../src/storage/db.js";
import { EventBus } from "../src/events/event-bus.js";

function check(name: string, fn: () => void): void {
  fn();
  console.log(`  ok  ${name}`);
}

console.log("context-smoke");

check("approxTokens ~len/4", () => {
  assert.equal(approxTokens("abcd"), 1);
  assert.equal(approxTokens("a".repeat(400)), 100);
});

check("clipToTokens respects the budget", () => {
  const clipped = clipToTokens("x".repeat(4000), 100);
  assert.ok(approxTokens(clipped) <= 100);
  assert.ok(clipped.endsWith("…"));
  assert.equal(clipToTokens("short", 100), "short");
});

check("retrieval shaper shrinks a large payload >= 70%", () => {
  const chunks = Array.from({ length: 12 }, (_, i) => ({
    id: i,
    path: `src/feature/file-${i}.ts`,
    kind: "code",
    score: 0.91234,
    preview: `function feature${i}() {\n` + "  // body\n".repeat(120) + "}",
    startRow: 1,
    endRow: 120,
  }));
  const payload = {
    strategy: "hybrid(vector+keyword+symbols)",
    chunks,
    graphNodes: [{ id: "n1" }, { id: "n2" }],
    features: [{ name: "Feature", summary: "s".repeat(600) }],
  };
  const baseline = JSON.stringify(payload, null, 2);
  const shaped = shapeToolOutput("retrieve_knowledge", payload);
  const ratio = shaped.length / baseline.length;
  assert.ok(
    ratio <= 0.3,
    `expected >=70% reduction, got ${(100 - ratio * 100).toFixed(1)}%`
  );
  assert.ok(shaped.includes("omitted"), "omission marker missing");
});

check("terminal shaper keeps error lines and the tail", () => {
  const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
  lines[250] = "ERROR: something exploded";
  const payload = {
    exitCode: 1,
    output: lines.join("\n"),
    truncated: false,
    timedOut: false,
  };
  const shaped = shapeToolOutput("run_terminal", payload);
  assert.ok(shaped.startsWith("exit 1"));
  assert.ok(shaped.includes("ERROR: something exploded"));
  assert.ok(shaped.includes("line 499"), "tail lost");
  assert.ok(shaped.length < payload.output.length / 3, "not compressed");
});

check("read_file shaper returns raw text, not JSON", () => {
  const shaped = shapeToolOutput("read_file", {
    content: 'const x = "quoted";\nline2',
    mtime: 123,
    totalLines: 10,
  });
  assert.ok(shaped.includes('const x = "quoted";\nline2'));
  assert.ok(!shaped.includes("mtime"));
});

check("impact shaper caps arrays with omission counts", () => {
  const shaped = shapeToolOutput("analyze_impact", {
    targets: ["a.ts"],
    directDependents: Array.from({ length: 60 }, (_, i) => `dep-${i}.ts`),
  });
  const parsed = JSON.parse(shaped) as Record<string, unknown>;
  assert.equal((parsed.directDependents as string[]).length, 20);
  assert.equal(parsed.directDependentsOmitted, 40);
});

check("unknown tools fall back to compact JSON", () => {
  const shaped = shapeToolOutput("write_file", { path: "a.ts", applied: true });
  assert.equal(shaped, '{"path":"a.ts","applied":true}');
});

check("TokenLedger records, attaches usage, queries, and validates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-ctx-smoke-"));
  const db = openDb(dir);
  const bus = new EventBus();
  const seen: string[] = [];
  bus.subscribe((e) => {
    if (e.topic === "context.stats") seen.push(e.topic);
  });
  const ledger = new TokenLedger(db, bus);
  ledger.record({
    requestId: "req-1",
    taskId: "task-1",
    conversationId: "conv-1",
    purpose: "execute",
    sections: [{ name: "code", tokens: 500, items: 4 }],
    appendTokens: 700,
    estBaselineTokens: 1500,
    savedTokens: 800,
    savedPct: 53,
    cacheHit: false,
    dedupedChunks: 0,
    at: Date.now(),
  });
  ledger.attachSdkUsage("task-1", "conv-1", "execute", {
    input_tokens: 1200,
    cache_read_input_tokens: 9000,
    output_tokens: 300,
  });
  const { requests, totals } = ledger.query("conv-1");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.actualInputTokens, 1200);
  assert.equal(requests[0]!.cacheReadTokens, 9000);
  assert.equal(totals.requests, 1);
  assert.equal(totals.actualInputTokens, 1200);
  assert.ok(seen.length >= 2, "context.stats events not published");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

check("dedupeAndDiversify drops dupes and caps per-file chunks", () => {
  const mk = (id: number, path: string, hash: string): RetrievedChunk => ({
    id,
    path,
    kind: "code",
    score: 1 - id / 100,
    preview: "p",
    contentHash: hash,
  });
  const out = dedupeAndDiversify(
    [
      mk(1, "a.ts", "h1"),
      mk(2, "a.ts", "h1"), // duplicate hash
      mk(3, "a.ts", "h2"),
      mk(4, "a.ts", "h3"), // third chunk of a.ts — over the per-file cap
      mk(5, "b.ts", "h4"),
    ].map((chunk) => ({ chunk, rank: chunk.score }))
  );
  const ids = out.map((i) => i.chunk.id);
  assert.deepEqual(ids, [1, 3, 5]);
});

check("assembler stays inside budget with stable section order", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-ctx-asm-"));
  const db = openDb(dir);
  const bus = new EventBus();
  const ledger = new TokenLedger(db, bus);
  const assembler = new PromptAssembler({ db, ledger });

  const chunk = (id: number, path_: string): RetrievedChunk => ({
    id,
    path: path_,
    kind: "code",
    score: 1 - id / 20,
    preview: `function f${id}() {\n` + "  work();\n".repeat(80) + "}",
    startRow: 1,
    endRow: 80,
    tokenCount: 200,
    contentHash: `hash-${id}`,
  });
  const { text, stats } = assembler.assemble({
    taskId: "task-asm",
    conversationId: "conv-asm",
    intentKind: "fix",
    retrieval: {
      strategy: "hybrid(test)",
      chunks: Array.from({ length: 12 }, (_, i) => chunk(i + 1, `src/f${i}.ts`)),
      graphNodes: [],
      features: [],
    },
    radius: {
      targets: ["src/f0.ts"],
      affected: [],
      flows: [],
      testsAtRisk: [],
      companions: ["src/f0.spec.ts"],
      risks: [],
      level: "low",
      summary: "small",
    },
    plan: {
      id: "plan-1",
      taskId: "task-asm",
      goal: "Fix the bug in f0",
      steps: [
        { id: "s1", title: "Fix the bug", files: ["src/f0.ts"], status: "pending" },
      ],
      createdAt: Date.now(),
    },
  });

  const budget = budgetFor("fix");
  assert.ok(
    stats.appendTokens <= budget.totalTokens,
    `append ${stats.appendTokens} > total budget ${budget.totalTokens}`
  );
  for (const s of stats.sections) {
    assert.ok(s.tokens >= 0, `section ${s.name} negative`);
  }
  const codeIdx = text.indexOf("Most relevant code:");
  const planIdx = text.indexOf("PLAN (");
  assert.ok(codeIdx !== -1 && planIdx !== -1 && codeIdx < planIdx);
  assert.ok(stats.savedTokens > 0, "no savings vs naive baseline");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await (async () => {
  let calls = 0;
  const bus = new EventBus();
  const generation = new IndexGeneration(bus);
  const cached = new CachedRetriever(
    {
      retrieve: async () => {
        calls += 1;
        return { strategy: "test", chunks: [], graphNodes: [], features: [] };
      },
    },
    generation
  );
  await cached.retrieve("how does login work", 12);
  await cached.retrieve("how does login work", 12);
  assert.equal(calls, 1, "second identical query hit the inner retriever");
  assert.equal(cached.hits, 1);
  // A reindex bumps the generation and invalidates the entry.
  bus.publish("knowledge.updated", {
    files: ["a.ts"],
    symbolsDelta: 0,
    edgesDelta: 0,
    embeddingsDelta: 0,
  });
  await cached.retrieve("how does login work", 12);
  assert.equal(calls, 2, "generation bump did not invalidate the cache");
  console.log("  ok  CachedRetriever hits, misses, and invalidates");
})();

check("second assemble dedupes already-sent chunks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-ctx-dedup-"));
  const db = openDb(dir);
  const bus = new EventBus();
  const ledger = new TokenLedger(db, bus);
  const sent = new SentChunkStore(db);
  const summaries = new TaskSummaryStore(db);
  const assembler = new PromptAssembler({ db, ledger, sent, summaries });
  const retrieval = {
    strategy: "test",
    chunks: [
      {
        id: 1,
        path: "src/auth.ts",
        kind: "code" as const,
        score: 0.9,
        preview: "function login() {\n  // …\n}",
        tokenCount: 50,
        contentHash: "stable-hash-1",
      },
    ],
    graphNodes: [],
    features: [],
  };
  const base = {
    conversationId: "conv-d",
    intentKind: "fix",
    retrieval,
    radius: {
      targets: [],
      affected: [],
      flows: [],
      testsAtRisk: [],
      companions: [],
      risks: [],
      level: "low" as const,
      summary: "",
    },
    plan: {
      id: "p",
      taskId: "t",
      goal: "g",
      steps: [],
      createdAt: Date.now(),
    },
  };
  const first = assembler.assemble({ ...base, taskId: "task-1" });
  assert.equal(first.stats.dedupedChunks, 0);
  assert.ok(first.text.includes("function login"));
  summaries.save(
    buildTaskSummary({
      taskId: "task-1",
      conversationId: "conv-d",
      intentSummary: "Fixed the login bug",
      changedFiles: ["src/auth.ts"],
      validation: [],
      planGoal: "g",
    })
  );
  const second = assembler.assemble({ ...base, taskId: "task-2" });
  assert.equal(second.stats.dedupedChunks, 1, "chunk not deduped");
  assert.ok(second.text.includes("(already in context)"));
  assert.ok(!second.text.includes("function login"), "code re-sent");
  assert.ok(second.text.includes("RECENT WORK IN THIS SESSION"));
  assert.ok(second.text.includes("Fixed the login bug"));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log("context-smoke: all checks passed");
