/**
 * Symbol-level edit-impact smoke: editing a line resolves to its symbol,
 * reports export status, and finds who USES that symbol (this file + other
 * files), so update-vs-isolate is answerable.
 *
 *   pnpm --filter @atelier/agent smoke:symbol-impact
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
import { SymbolImpactAnalyzer } from "../src/knowledge/impact/symbol-impact.js";

// formatMoney (exported, used cross-file) vs localHelper (used same-file only)
const MONEY = `export function formatMoney(cents: number): string {
  return "$" + (cents / 100).toFixed(2);
}

function localHelper(n: number): number {
  return n * 2;
}

export function twice(n: number): number {
  return localHelper(n);
}
`;
const CONSUMER = `import { formatMoney } from "./money";
export function Receipt(cents: number): string {
  return "Total: " + formatMoney(cents);
}
`;

// A dynamic/string-keyed user: mentions renderInvoice by name but there is
// no resolvable import/call edge — only the textual arm should catch it.
const DYNAMIC = `const registry: Record<string, (x: number) => string> = {};
export function dispatch(key: string, x: number) {
  return registry["renderInvoice"] ? registry[key](x) : "";
}
`;

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-symimp-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-symimpdb-"));
  const modelDir = path.join(os.tmpdir(), "atelier-smoke-models");
  fs.mkdirSync(modelDir, { recursive: true });

  write(root, "src/money.ts", MONEY);
  write(root, "src/Receipt.tsx", CONSUMER);
  write(root, "src/invoice.ts", "export function renderInvoice(x: number) { return String(x); }\n");
  write(root, "src/dynamic.ts", DYNAMIC);

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

  // Textual fallback: word-boundary search over the workspace, so dynamic
  // string-keyed uses surface even without a resolved edge.
  const { FileService } = await import("../src/workspace/file-service.js");
  const files = new FileService(
    new PathGuard(root),
    new WorkspaceIgnore(root, []),
    bus
  );
  const analyzer = new SymbolImpactAnalyzer(db, async (identifier) => {
    const esc = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = await files.search(`\\b${esc}\\b`, undefined, 200, true);
    return m.map((x) => ({ path: x.path, row: x.row }));
  });
  let fail = 0;
  const check = (name: string, ok: boolean, extra = "") => {
    if (!ok) fail += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  };

  // Editing line 2 sits inside formatMoney (exported, used in Receipt.tsx).
  const shared = await analyzer.analyze("src/money.ts", 2);
  check("resolves line to enclosing symbol", shared?.symbol === "formatMoney", shared?.symbol);
  check("detects export", shared?.exported === true);
  check(
    "finds cross-file user (Receipt)",
    (shared?.externalFiles ?? []).some((f) => f.includes("Receipt")),
    (shared?.externalFiles ?? []).join(", ") || "none"
  );
  check("reach is shared", shared?.reach === "shared", shared?.reach);

  // localHelper is used only within money.ts (twice) — local, not shared.
  const local = await analyzer.analyze("src/money.ts", undefined, "localHelper");
  check("local symbol resolves", local?.symbol === "localHelper");
  check("local not exported", local?.exported === false);
  check(
    "local reach is local (same-file use only)",
    local?.reach === "local",
    `${local?.reach} ext=${(local?.externalFiles ?? []).length}`
  );

  // renderInvoice has NO resolved caller (only a string-keyed mention in
  // dynamic.ts) — the textual arm must surface it and flag it to verify.
  const dyn = await analyzer.analyze("src/invoice.ts", undefined, "renderInvoice");
  check(
    "textual arm catches string-keyed use",
    (dyn?.textualFiles ?? []).some((f) => f.includes("dynamic")),
    (dyn?.textualFiles ?? []).join(", ") || "none"
  );
  check(
    "not reported as isolated despite no resolved edge",
    dyn?.reach === "shared",
    dyn?.reach
  );
  check(
    "summary flags textual as unresolved/verify",
    Boolean(dyn?.summary.toLowerCase().includes("verify")),
    dyn?.summary
  );

  await embedder.shutdown().catch(() => undefined);
  db.close();
  for (const dir of [root, dataDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // harmless
    }
  }
  console.log(fail === 0 ? "\nall symbol-impact cases pass" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
