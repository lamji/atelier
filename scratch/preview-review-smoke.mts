/**
 * Smoke for the preview_review browser path: serves a tiny page with known
 * defects, drives it through the same launch fallback the tool uses, and
 * prints what the audit found. No sqlite, so plain tsx can run it.
 */
import { createServer } from "node:http";
import { chromium, type LaunchOptions } from "playwright-core";

const PAGE = `<!doctype html><html><head><title>Smoke</title></head><body>
<h1>Preview review smoke</h1>
<button></button>
<button style="width:10px;height:10px">x</button>
<input type="text" />
<img src="/missing.png" />
<div id="dup"></div><div id="dup"></div>
</body></html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGE);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as { port: number };
const url = `http://127.0.0.1:${port}/`;

const attempts: Array<{ label: string; options: LaunchOptions }> = [
  { label: "chrome", options: { channel: "chrome", headless: true } },
  { label: "msedge", options: { channel: "msedge", headless: true } },
  { label: "bundled Chromium", options: { headless: true } },
];

let browser = null;
let used = "";
const errors: string[] = [];
for (const attempt of attempts) {
  try {
    browser = await chromium.launch(attempt.options);
    used = attempt.label;
    break;
  } catch (error) {
    errors.push(`${attempt.label}: ${(error as Error).message.split("\n")[0]}`);
  }
}
if (!browser) {
  console.error("NO BROWSER:", errors.join(" | "));
  server.close();
  process.exit(1);
}

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const response = await page.goto(url, { waitUntil: "domcontentloaded" });
const found = await page.evaluate(() => {
  const issues: string[] = [];
  for (const el of document.querySelectorAll("button")) {
    const r = el.getBoundingClientRect();
    if (!el.textContent?.trim()) issues.push("unnamed button");
    if (r.width < 24 || r.height < 24) issues.push("small target");
  }
  for (const img of document.images) {
    if (!img.complete || img.naturalWidth === 0) issues.push("broken image");
    if (!img.hasAttribute("alt")) issues.push("missing alt");
  }
  return { title: document.title, issues: [...new Set(issues)] };
});
await page.screenshot({ path: "scratch/preview-review-smoke.png", fullPage: true });
console.log("browser:", used);
console.log("status:", response?.status());
console.log("audit:", JSON.stringify(found));
await browser.close();
server.close();
