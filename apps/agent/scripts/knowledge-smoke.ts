/**
 * Phase 5 smoke: index this repo, verify incremental behavior, run a
 * retrieval, and print the graph around a known symbol.
 *
 *   pnpm --filter @atelier/agent smoke:knowledge
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { openDb } from "../src/storage/db.js";
import { EventBus } from "../src/events/event-bus.js";
import { PathGuard } from "../src/workspace/path-guard.js";
import { WorkspaceIgnore } from "../src/workspace/ignore.js";
import { Embedder, EMBEDDING_DIMS } from "../src/knowledge/embeddings/embedder.js";
import { VectorStore } from "../src/knowledge/embeddings/vector-store.js";
import { IncrementalIndexer } from "../src/knowledge/indexer/incremental-indexer.js";
import { KnowledgeQuery } from "../src/knowledge/query/knowledge-query.js";
import { SymbolGraph } from "../src/knowledge/graph/symbol-graph.js";
import { LessonStore } from "../src/knowledge/lessons/lesson-store.js";
import { Retriever } from "../src/rag/retriever.js";

const log = pino({ transport: { target: "pino-pretty" }, level: "info" });

async function main(): Promise<void> {
  const workspaceRoot = path.resolve(import.meta.dirname, "..", "..", "..");
  // Fixed cache dir: the embedding model downloads once, and repeat runs
  // exercise the incremental (warm-db) path.
  const dataDir = path.join(os.tmpdir(), "atelier-ksmoke-cache");
  fs.mkdirSync(dataDir, { recursive: true });
  log.info({ workspaceRoot, dataDir }, "smoke start");

  const db = openDb(dataDir);
  const bus = new EventBus();
  let updates = 0;
  bus.subscribe((e) => {
    if (e.topic === "knowledge.updated") updates += 1;
  });

  const guard = new PathGuard(workspaceRoot);
  const ig = new WorkspaceIgnore(workspaceRoot);
  const embedder = new Embedder(dataDir);
  const vectors = new VectorStore(db, EMBEDDING_DIMS);
  const indexer = new IncrementalIndexer(
    db, bus, guard, ig, workspaceRoot, embedder, vectors, log
  );
  const knowledge = new KnowledgeQuery(db);
  const graph = new SymbolGraph(db);
  const lessons = new LessonStore(db, bus, embedder, vectors);
  const retriever = new Retriever(db, embedder, vectors, knowledge, lessons);

  const t0 = Date.now();
  await indexer.start();
  await indexer.drainFor([]);
  log.info({ ms: Date.now() - t0, stats: knowledge.stats() }, "initial index");

  // Incremental check: re-scan must enqueue nothing (all clean).
  const t1 = Date.now();
  await indexer.indexWorkspace(false);
  await indexer.drainFor([]);
  log.info({ ms: Date.now() - t1 }, "clean re-scan (should be ~instant)");

  // Single-file incremental: touch one file's content hash.
  const target = "apps/agent/src/git/git-service.ts";
  const abs = path.join(workspaceRoot, target);
  const original = fs.readFileSync(abs, "utf8");
  fs.writeFileSync(abs, original + "\n// smoke-touch\n");
  const t2 = Date.now();
  try {
    indexer.enqueueFile(target);
    await indexer.drainFor([target]);
    log.info({ ms: Date.now() - t2 }, "single-file incremental");
  } finally {
    fs.writeFileSync(abs, original);
    indexer.enqueueFile(target);
    await indexer.drainFor([target]);
  }

  // Retrieval DoD: "where is X handled?"
  for (const q of [
    "where are git commits handled?",
    "how does the terminal manager create sessions?",
  ]) {
    const result = await retriever.retrieve(q, 5);
    log.info(
      {
        query: q,
        strategy: result.strategy,
        top: result.chunks.map((c) => `${c.path} (${c.score})`),
        symbols: result.graphNodes.map((n) => n.label),
      },
      "retrieval"
    );
  }

  // Vector arm: wait for the embedding model + backfill, then re-retrieve.
  log.info("waiting for embedder (first run downloads the model)…");
  await embedder.init();
  if (embedder.available) {
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      const s = knowledge.stats();
      if (s.embedded >= s.chunks || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const result = await retriever.retrieve("where are git commits handled?", 5);
    log.info(
      {
        strategy: result.strategy,
        top: result.chunks.map((c) => `${c.path} (${c.score})`),
        embedded: knowledge.stats().embedded,
      },
      "retrieval with vectors"
    );
  } else {
    log.warn({ reason: embedder.failureReason }, "embedder unavailable");
  }

  // Lessons: save -> dedupe merge -> retrieval surfaces it -> impact sees it.
  const saved = await lessons.save(
    {
      title: "GitService.commit must refresh snapshot after committing",
      lesson:
        "After git commit, always call refresh() or the UI shows stale " +
        "status. Confirmed after several wrong attempts.",
      kind: "bug-fix",
      symbols: ["GitService"],
      files: ["apps/agent/src/git/git-service.ts"],
    },
    "task_smoke"
  );
  const dup = await lessons.save(
    {
      title: "GitService.commit must refresh snapshot after committing",
      lesson:
        "After a git commit you must call refresh() so the UI never shows " +
        "stale status. Confirmed fix.",
      kind: "bug-fix",
      symbols: ["GitService"],
    },
    "task_smoke"
  );
  const lessonHit = await retriever.retrieve("bug in GitService commit", 6);
  const impactWithLesson = graph.dependentsOf([
    "apps/agent/src/git/git-service.ts",
  ]);
  log.info(
    {
      savedId: saved.lesson.id,
      savedLinks: saved.lesson.links,
      dedupeMerged: dup.merged,
      lessonInRetrieval: lessonHit.chunks.some((c) => c.kind === "lesson"),
      strategy: lessonHit.strategy,
      impactLessons: impactWithLesson.lessons.map((l) => l.title),
      lessonCount: knowledge.stats().lessons,
    },
    "lessons"
  );

  // Graph checks.
  const fileGraph = graph.graphFor("file", "apps/agent/src/main.ts", 1);
  const symGraph = graph.graphFor("symbol", "startTask", 1);
  const impact = graph.dependentsOf(["apps/agent/src/events/event-bus.ts"]);
  log.info(
    {
      fileGraph: { nodes: fileGraph.nodes.length, edges: fileGraph.edges.length },
      symGraph: { nodes: symGraph.nodes.length, edges: symGraph.edges.length },
      impactFiles: impact.files.length,
      updates,
    },
    "graph + impact"
  );

  indexer.stop();
  db.close();
  log.info("smoke done");
  // The ONNX runtime keeps handles open; let the process exit naturally.
  process.exit(0);
}

main().catch((error) => {
  log.error(error);
  process.exit(1);
});
