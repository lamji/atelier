/**
 * Post-edit review smoke, in two halves.
 *
 * INPUTS — the two things the model cannot gather itself: near-identical
 * code in files no import edge reaches, and the companion files of what
 * changed. Builds a throwaway workspace with a component whose twin
 * carries the same bug (the PR-review case), indexes it, and asserts the
 * sweep finds the twin while ignoring unrelated code.
 *
 * GATE — the verdict parser that decides pass/fail. The pipeline smoke
 * drives a question-intent task, which skips the review stage outright, so
 * nothing else exercises this.
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
import {
  extractVerdict,
  retryBudget,
  withoutVerdictLine,
} from "../src/orchestrator/pipeline-executor.js";
import {
  buildReviewFixPrompt,
  buildReviewPrompt,
} from "../src/orchestrator/review-prompt.js";
import { touchesCode } from "../src/orchestrator/change-scale/index.js";
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

  // --- verdict gate: what the pipeline actually branches on -------------
  const verdictCases: Array<{
    name: string;
    text: string;
    verdict: "pass" | "fail";
    findings: number;
  }> = [
    {
      name: "clean pass",
      text: '1. OK\n2. OK\nVERDICT_JSON: {"verdict":"pass","findings":[]}',
      verdict: "pass",
      findings: 0,
    },
    {
      name: "fail carries its findings to the fix round",
      text:
        "1. ISSUE: twin left unfixed\n" +
        'VERDICT_JSON: {"verdict":"fail","findings":["twin left unfixed",' +
        '"unreachable error state"]}',
      verdict: "fail",
      findings: 2,
    },
    {
      name: "malformed JSON falls back to the prose ISSUE lines",
      text:
        "- ISSUE: unused import in a.ts\n" +
        "2. ISSUE: half-applied rename\n" +
        "VERDICT_JSON: {verdict: fail",
      verdict: "fail",
      findings: 2,
    },
    {
      name: "braces in the prose do not hijack the verdict",
      text:
        'The diff adds `{ ok: true }` and the string {"verdict":"pass"}.\n' +
        'VERDICT_JSON: {"verdict":"fail","findings":["real defect"]}',
      verdict: "fail",
      findings: 1,
    },
    {
      name: "no verdict line fails closed",
      text: "Looks fine to me, shipping it.",
      verdict: "fail",
      findings: 0,
    },
    { name: "empty output fails closed", text: "", verdict: "fail", findings: 0 },
  ];

  for (const c of verdictCases) {
    const got = extractVerdict(c.text);
    check(
      c.name,
      got.verdict === c.verdict && got.findings.length === c.findings,
      `got ${got.verdict}/${got.findings.length}, want ${c.verdict}/${c.findings}`
    );
  }

  // The prompt must keep asking for the exact line the parser reads, and
  // must carry the yardstick the reviewer judges against. Without the
  // request in the prompt the reviewer grades an imaginary ideal PR and
  // fails changes for work nobody asked for.
  const reviewPrompt = buildReviewPrompt({
    changedFiles: [changed],
    similar: [],
    companionFiles: [],
    request: "add the allow-origin value to the backend env file",
    constraints: ["direct fix"],
  });
  check(
    "prompt still requests the VERDICT_JSON line",
    reviewPrompt.includes("VERDICT_JSON")
  );
  check(
    "prompt carries the user's request as the yardstick",
    reviewPrompt.includes("add the allow-origin value to the backend env file")
  );
  check(
    "prompt carries the user's scope limits",
    reviewPrompt.includes("direct fix")
  );
  check(
    "prompt rules out-of-scope work off the finding list",
    /NOT A FINDING/i.test(reviewPrompt) &&
      /repo hygiene/i.test(reviewPrompt)
  );

  // --- review depth follows the change ------------------------------------
  const inertCases: Array<{ paths: string[]; code: boolean }> = [
    { paths: ["apps/backend/.env"], code: false },
    { paths: ["apps/backend/.env", "apps/backend/.env.example"], code: false },
    { paths: ["README.md", "docs/setup.md", "public/logo.svg"], code: false },
    { paths: ["pnpm-lock.yaml", ".gitignore"], code: false },
    { paths: ["apps/backend/.env", "apps/backend/main.go"], code: true },
    { paths: ["src/app.component.ts"], code: true },
    { paths: ["tsconfig.json"], code: true },
    { paths: ["Dockerfile"], code: true },
    { paths: [], code: false },
  ];
  for (const c of inertCases) {
    check(
      `touchesCode(${c.paths.join(", ") || "nothing"}) === ${c.code}`,
      touchesCode(c.paths) === c.code
    );
  }

  // --- the machine line never reaches the transcript --------------------
  const report =
    "OK - reachable states wired correctly\n" +
    "ISSUE: orgTier.ts serializes limitUsd as Infinity\n" +
    'VERDICT_JSON: {"verdict":"fail","findings":["orgTier.ts serializes"]}';
  const stripped = withoutVerdictLine(report);
  check(
    "verdict line stripped from the shown report",
    !stripped.includes("VERDICT_JSON") && stripped.includes("ISSUE: orgTier")
  );
  check(
    "report with no verdict line survives untouched",
    withoutVerdictLine("OK - all clean") === "OK - all clean"
  );
  check(
    "verdict still parses from the RAW text",
    extractVerdict(report).verdict === "fail"
  );

  // --- the repair round is told enough to act -----------------------------
  const fixPrompt = buildReviewFixPrompt({
    findings: ["orgTier.ts serializes limitUsd as Infinity", "dead export"],
    changedFiles: ["src/orgTier.ts", "src/tierEntitlements.ts"],
    request: "cap the tenant spend",
    attempt: 1,
    maxAttempts: 3,
  });
  check(
    "fix prompt carries every finding",
    fixPrompt.includes("orgTier.ts serializes limitUsd as Infinity") &&
      fixPrompt.includes("dead export")
  );
  check(
    "fix prompt names the changed files",
    fixPrompt.includes("src/orgTier.ts") &&
      fixPrompt.includes("src/tierEntitlements.ts")
  );
  check(
    "fix prompt keeps the original request in scope",
    fixPrompt.includes("cap the tenant spend")
  );
  check(
    "fix prompt warns that a re-review follows",
    /re-check|reviewer re-/i.test(fixPrompt)
  );

  await embedder.shutdown().catch(() => undefined);
  db.close();
  // --- review speed: inlined diff and a size-scaled retry budget ---
  const base = {
    changedFiles: ["src/a.ts"],
    similar: [],
    companionFiles: [],
    request: "fix the parser",
    constraints: [],
  };
  const patch = "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-const x = 1;\n+const x = 2;";
  const withDiff = buildReviewPrompt({ ...base, diff: patch });
  check("inlined diff carries the patch", withDiff.includes("+const x = 2;"));
  check(
    "inlined diff tells the reviewer not to re-fetch it",
    withDiff.includes("do not call the git tool")
  );
  const noDiff = buildReviewPrompt(base);
  check(
    "no diff falls back to fetching it",
    noDiff.includes('git tool, action "diff"') && !noDiff.includes("```diff")
  );
  const huge = buildReviewPrompt({ ...base, diff: "x".repeat(40000) });
  check(
    "oversized diff is not inlined",
    !huge.includes("```diff") && huge.includes("Read it in pieces")
  );
  // The checklist has to survive every branch — it is what the verdict parses.
  for (const [name, text] of [["inlined", withDiff], ["fallback", noDiff], ["large", huge]] as const) {
    check(`${name} prompt keeps the verdict contract`, text.includes("VERDICT_JSON"));
  }
  check("2-file change gets one repair round", retryBudget(2) === 1);
  check("5-file change gets two", retryBudget(5) === 2);
  check("wide change keeps the full budget", retryBudget(20) === 3);

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
