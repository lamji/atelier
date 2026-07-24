/**
 * Post-edit review inputs smoke: the two things the model cannot gather
 * itself — near-identical code in files no import edge reaches, and the
 * companion files of what changed.
 *
 * Builds a throwaway workspace with a component whose twin carries the
 * same bug (the PR-review case), indexes it, and asserts the sweep finds
 * the twin while ignoring unrelated code.
 *
 *   pnpm --filter @atelier/agent smoke:review
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/storage/db.js";
import { EventBus } from "../src/events/event-bus.js";
import { PathGuard } from "../src/workspace/path-guard.js";
import { WorkspaceIgnore } from "../src/workspace/ignore.js";
import { Embedder, EMBEDDING_DIMS } from "../src/knowledge/embeddings/embedder.js";
import { VectorStore } from "../src/knowledge/embeddings/vector-store.js";
import { IncrementalIndexer } from "../src/knowledge/indexer/incremental-indexer.js";
import { CloneScanner } from "../src/knowledge/impact/clone-scan.js";
import { companionFilesFor } from "../src/knowledge/impact/companion-files.js";
import pino from "pino";

/** The file the task "fixed" — expiry reshuffle with the separator stripped. */
const FIXED = `export class QrCreditPaymentComponent {
  processPayment(form: PaymentForm): void {
    const digits = String(form.cardExpiration ?? "").replace(/\\D/g, "");
    const payload = {
      CardPan: form.cardPan,
      CardCvv: form.cardCvv,
      CardExpiration: \`\${digits.substring(2, 4)}\${digits.substring(0, 2)}\`,
      OrderIdentifier: form.orderId,
      TotalAmount: form.amount,
    };
    this.gateway.sale(payload);
  }
}
`;

/** Its twin: same shape, separator NOT stripped — the unfixed sibling. */
const TWIN = `export class PowertranzPaymentComponent {
  salePowerTranz(form: PaymentForm): void {
    const str = form.cardExpiration.toString();
    const payload = {
      CardPan: form.cardPan,
      CardCvv: form.cardCvv,
      CardExpiration: \`\${str.substring(2, 4)}\${str.substring(0, 2)}\`,
      OrderIdentifier: form.orderId,
      TotalAmount: form.amount,
    };
    this.gateway.sale(payload);
  }
}
`;

/** Unrelated code that must NOT be reported as a twin. */
const UNRELATED = `export class InventoryReportService {
  buildMonthlyReport(rows: StockRow[]): ReportSummary {
    const grouped = new Map<string, number>();
    for (const row of rows) {
      grouped.set(row.sku, (grouped.get(row.sku) ?? 0) + row.quantity);
    }
    return { generatedAt: this.clock.now(), lines: [...grouped.entries()] };
  }
}
`;

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-review-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-reviewdb-"));
  // Model cache is shared and kept: downloading MiniLM per run is minutes.
  const modelDir = path.join(os.tmpdir(), "atelier-smoke-models");
  fs.mkdirSync(modelDir, { recursive: true });

  const changed = "src/app/qrcredit/qrcredit-payment.component.ts";
  write(root, changed, FIXED);
  write(root, "src/app/qrcredit/qrcredit-payment.component.html", "<form></form>");
  write(root, "src/app/qrcredit/qrcredit-payment.component.spec.ts", "describe('x', () => {});");
  write(root, "src/app/powertranz/powertranz-payment.component.ts", TWIN);
  write(root, "src/app/reports/inventory-report.service.ts", UNRELATED);

  const db = openDb(dataDir);
  const bus = new EventBus();
  const guard = new PathGuard(root);
  const ig = new WorkspaceIgnore(root, []);
  const embedder = new Embedder(modelDir);
  const vectors = new VectorStore(db, EMBEDDING_DIMS);
  const log = pino({ level: "silent" });
  const indexer = new IncrementalIndexer(db, bus, guard, ig, root, embedder, vectors, log);
  // The agent does this in start(); without a loaded model the index
  // writes chunks with no embeddings and the sweep has nothing to search.
  await embedder.init();

  let fail = 0;
  const check = (name: string, ok: boolean, extra = "") => {
    if (!ok) fail += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  };

  await indexer.indexWorkspace(true);
  await indexer.drainFor([]);

  // --- companion files: the other half of the component -----------------
  const companions = companionFilesFor(root, [changed]);
  check(
    "companions include the template and spec",
    companions.some((f) => f.endsWith("qrcredit-payment.component.html")) &&
      companions.some((f) => f.endsWith("qrcredit-payment.component.spec.ts")),
    companions.join(", ")
  );
  check(
    "companions exclude the changed file itself",
    !companions.includes(changed)
  );
  check(
    "companions exclude unrelated files",
    !companions.some((f) => f.includes("inventory-report"))
  );

  // --- clone sweep: the unfixed twin no import edge reaches -------------
  await embedder.init();
  if (!embedder.available) {
    console.log(`      embedder failure: ${embedder.failureReason}`);
    console.log(
      "\nSKIP  clone sweep — embedder unavailable in this environment"
    );
  } else {
    const scanner = new CloneScanner(db, embedder, vectors);
    const hits = await scanner.siblingsOf([changed]);
    const twin = hits.find((h) => h.path.includes("powertranz-payment"));
    check(
      "sweep finds the unfixed twin",
      twin !== undefined,
      hits.map((h) => `${h.path}@${h.score}`).join(", ") || "no hits"
    );
    check(
      "sweep does not report the changed file itself",
      !hits.some((h) => h.path === changed)
    );
    check(
      "unrelated service ranks below the twin (or is absent)",
      twin !== undefined &&
        hits.every(
          (h) => !h.path.includes("inventory-report") || h.score < twin.score
        )
    );
  }

  await embedder.shutdown().catch(() => undefined);
  db.close();
  // The ONNX runtime can still hold handles on Windows; cleanup is
  // best-effort and must never fail the run.
  for (const dir of [root, dataDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // temp dir stays behind; harmless
    }
  }
  console.log(fail === 0 ? "\nall review cases pass" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
