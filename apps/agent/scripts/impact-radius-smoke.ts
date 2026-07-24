/**
 * Impact-radius smoke: editing a leaf util should surface its transitive
 * callers (child-of-child), the downstream component flow, and the spec
 * that covers it — the blast radius a 1-hop dependents query misses.
 *
 *   pnpm --filter @atelier/agent smoke:impact-radius
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
import { SymbolGraph } from "../src/knowledge/graph/symbol-graph.js";
import { ImpactAnalyzer } from "../src/knowledge/impact/impact-analyzer.js";

// leaf util  <-  service  <-  component (a 3-hop reverse chain)
const UTIL = `export function formatMoney(cents: number): string {
  return "$" + (cents / 100).toFixed(2);
}
`;
const SERVICE = `import { formatMoney } from "./money";
export function buildReceipt(cents: number): string {
  return "Total: " + formatMoney(cents);
}
`;
const COMPONENT = `import { buildReceipt } from "./receipt-service";
export function CheckoutSummary(cents: number): string {
  return buildReceipt(cents);
}
`;
const SPEC = `import { formatMoney } from "./money";
describe("money", () => { it("formats", () => { formatMoney(100); }); });
`;
const UNRELATED = `export function slugify(s: string): string {
  return s.toLowerCase().replace(/\\s+/g, "-");
}
`;

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-radius-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-radiusdb-"));
  const modelDir = path.join(os.tmpdir(), "atelier-smoke-models");
  fs.mkdirSync(modelDir, { recursive: true });

  const target = "src/checkout/money.ts";
  write(root, target, UTIL);
  write(root, "src/checkout/receipt-service.ts", SERVICE);
  write(root, "src/checkout/CheckoutSummary.tsx", COMPONENT);
  write(root, "src/checkout/money.spec.ts", SPEC);
  write(root, "src/util/slugify.ts", UNRELATED);

  const db = openDb(dataDir);
  const bus = new EventBus();
  const embedder = new Embedder(modelDir);
  const vectors = new VectorStore(db, EMBEDDING_DIMS);
  const indexer = new IncrementalIndexer(
    db,
    bus,
    new PathGuard(root),
    new WorkspaceIgnore(root, []),
    root,
    embedder,
    vectors,
    pino({ level: "silent" })
  );
  await indexer.indexWorkspace(true);
  await indexer.drainFor([]);

  const graph = new SymbolGraph(db);
  const analyzer = new ImpactAnalyzer(db, graph, root);
  const radius = analyzer.analyze([target]);

  let fail = 0;
  const check = (name: string, ok: boolean, extra = "") => {
    if (!ok) fail += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  };

  const paths = radius.affected.map((a) => a.path);
  check(
    "direct caller (service) in radius",
    paths.some((p) => p.includes("receipt-service")),
    paths.join(", ") || "empty"
  );
  check(
    "transitive caller (component) in radius",
    paths.some((p) => p.includes("CheckoutSummary"))
  );
  check(
    "transitive hop has depth > 1",
    radius.affected.some((a) => a.path.includes("CheckoutSummary") && a.depth >= 2),
    radius.affected.map((a) => `${a.path}@d${a.depth}`).join(", ")
  );
  check(
    "spec surfaced as test at risk",
    radius.testsAtRisk.some((t) => t.includes("money.spec")),
    radius.testsAtRisk.join(", ") || "none"
  );
  check(
    "unrelated util NOT in radius",
    !paths.some((p) => p.includes("slugify"))
  );
  check("summary is populated", radius.summary.length > 0, radius.summary);
  console.log(`      level=${radius.level} affected=${radius.affected.length}`);

  await embedder.shutdown().catch(() => undefined);
  db.close();
  for (const dir of [root, dataDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // temp dir stays behind; harmless
    }
  }
  console.log(fail === 0 ? "\nall impact-radius cases pass" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
