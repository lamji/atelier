/**
 * Runtime smoke for the preview_review tool: serves a tiny page with known
 * defects and drives the REAL registered tool impl (launchBrowser fallback +
 * auditPage evaluate + screenshots) against it. Lives in apps/agent so
 * playwright-core resolves; imports no sqlite, so plain tsx can run it.
 *
 *   cd apps/agent && pnpm exec tsx scripts/preview-review-smoke.mts
 */
import { createServer } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { chromium, type LaunchOptions } from "playwright-core";
import { registerPreviewReviewTools } from "../src/tools/preview-review-tools.js";
import type { ToolContext, ToolImpl, ToolRegistry } from "../src/tools/registry.js";

const PAGE = `<!doctype html><html><head><title>Smoke</title></head><body>
<h1 id="smoke-heading">Loading preview…</h1>
<button></button>
<button style="width:10px;height:10px">x</button>
<input type="text" />
<img src="/missing.png" />
<div id="dup"></div><div id="dup"></div>
<div style="width:3000px">wide</div>
<script>
  console.error("preview-smoke-console-error", { code: 500 });
  setTimeout(() => { throw new Error("preview-smoke-page-error"); }, 0);
  setTimeout(() => {
    document.querySelector("#smoke-heading").textContent = "Preview review smoke";
  }, 700);
</script>
</body></html>`;

const server = createServer((req, res) => {
  if (req.url === "/missing.png") {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGE);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as { port: number };
const url = `http://127.0.0.1:${port}/`;

// Which channel the fallback actually lands on — the tool's result does not say.
const attempts: Array<{ label: string; options: LaunchOptions }> = [
  { label: "chrome", options: { channel: "chrome", headless: true } },
  { label: "msedge", options: { channel: "msedge", headless: true } },
  { label: "bundled Chromium", options: { headless: true } },
];
const probeErrors: string[] = [];
for (const attempt of attempts) {
  try {
    const probe = await chromium.launch(attempt.options);
    console.log(`launch fallback landed on: ${attempt.label} (${probe.version()})`);
    if (probeErrors.length) console.log(`  skipped: ${probeErrors.join(" | ")}`);
    await probe.close();
    break;
  } catch (error) {
    probeErrors.push(`${attempt.label}: ${(error as Error).message.split("\n")[0]}`);
  }
}

const outRoot = await mkdtemp(path.join(process.cwd(), "preview-review-smoke-"));
let impl: ToolImpl | null = null;
const registry = {
  register: (name: string, tool: ToolImpl) => {
    if (name === "preview_review") impl = tool;
  },
} as unknown as ToolRegistry;
registerPreviewReviewTools(registry, outRoot);
if (!impl) throw new Error("preview_review was not registered");

const ctx: ToolContext = {
  taskId: "smoke",
  signal: new AbortController().signal,
  emitOutput: (chunk) => process.stdout.write(`  [tool] ${chunk}`),
};

let failed = false;
try {
  const result = (await (impl as ToolImpl)({ url }, ctx)) as {
    status: string;
    decision: string;
    browser: string;
    debug: {
      consoleErrors: string[];
      pageErrors: string[];
      failedRequests: string[];
    };
    viewports: Array<{
      name: string;
      status: number | null;
      screenshot: string;
      audit: { title: string; headings: string[]; interactive: string[]; issues: string[] };
      failedRequests: string[];
    }>;
  };
  console.log("browser:", result.browser);
  if (
    result.status !== "issues" ||
    result.decision !== "report-diagnostics-then-fix-or-skip" ||
    !result.debug.consoleErrors.some((line) =>
      line.includes("preview-smoke-console-error")
    ) ||
    !result.debug.pageErrors.some((line) =>
      line.includes("preview-smoke-page-error")
    ) ||
    result.debug.failedRequests.length === 0
  ) {
    failed = true;
    console.error("  FAIL: browser debugging evidence or decision was missing");
  }
  for (const view of result.viewports) {
    const bytes = (await stat(path.join(outRoot, view.screenshot))).size;
    console.log(`\n[${view.name}] status=${view.status} screenshot=${bytes}B title=${view.audit.title}`);
    console.log(`  headings: ${JSON.stringify(view.audit.headings)}`);
    console.log(`  interactive: ${view.audit.interactive.length} control(s)`);
    console.log(`  failedRequests: ${JSON.stringify(view.failedRequests)}`);
    for (const issue of view.audit.issues) console.log(`  issue: ${issue}`);
    if (view.audit.issues.length === 0) {
      failed = true;
      console.error(`  FAIL: auditPage found no issues on a page full of them`);
    }
    if (!view.audit.headings.includes("H1: Preview review smoke")) {
      failed = true;
      console.error(`  FAIL: preview was audited before its delayed UI settled`);
    }
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  const unavailable = (await (impl as ToolImpl)({ url }, ctx)) as {
    status: string;
    decision: string;
  };
  const unavailableOk =
    unavailable.status === "unavailable" &&
    unavailable.decision === "ask-user-to-start-preview";
  console.log(
    unavailableOk
      ? "\nunavailable preview returns an ask-user decision"
      : "\nFAIL: unavailable preview decision was not returned"
  );
  if (!unavailableOk) failed = true;
} catch (error) {
  failed = true;
  console.error("FAIL:", error);
} finally {
  await rm(outRoot, { recursive: true, force: true });
  if (server.listening) server.close();
}
console.log(failed ? "\nSMOKE FAILED" : "\nSMOKE OK");
process.exit(failed ? 1 : 0);
