import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type Browser,
  type ConsoleMessage,
  type LaunchOptions,
  type Page,
} from "playwright-core";
import type { ToolRegistry } from "./registry.js";

interface PreviewReviewInput {
  url: string;
}

interface BrowserAudit {
  title: string;
  text: string;
  headings: string[];
  interactive: string[];
  issues: string[];
}

/** One line of the page's DevTools console, in the order it was printed. */
interface ConsoleEntry {
  level: "log" | "info" | "warning" | "error" | "debug";
  text: string;
  location: string | null;
}

interface ViewportReview {
  name: "desktop" | "mobile";
  width: number;
  height: number;
  url: string;
  status: number | null;
  screenshot: string;
  audit: BrowserAudit;
  /** The whole console stream, chronological — what DevTools would show. */
  console: string[];
  consoleErrors: string[];
  consoleWarnings: string[];
  pageErrors: string[];
  failedRequests: string[];
}

const VIEWPORTS = [
  { name: "desktop" as const, width: 1440, height: 900 },
  { name: "mobile" as const, width: 390, height: 844 },
];

const MAX_CONSOLE_ENTRIES = 120;
const NAVIGATION_TIMEOUT_MS = 10_000;
const PAGE_OPERATION_TIMEOUT_MS = 5_000;
const CONSOLE_RESOLVE_TIMEOUT_MS = 750;
const PAGE_SETTLE_TIMEOUT_MS = 5_000;
const PAGE_SETTLE_MIN_MS = 2_500;
const PAGE_STABLE_WINDOW_MS = 600;
const PAGE_SETTLE_POLL_MS = 200;
const BROWSER_CLOSE_TIMEOUT_MS = 1_500;
const BROWSER_LAUNCH_TIMEOUT_MS = 8_000;

function consoleLevel(type: string): ConsoleEntry["level"] {
  if (type === "error" || type === "warning" || type === "debug" || type === "info") {
    return type;
  }
  return "log";
}

function formatLocation(location: {
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}): string | null {
  if (!location.url) return null;
  const line = typeof location.lineNumber === "number" ? ":" + location.lineNumber : "";
  const column =
    typeof location.columnNumber === "number" ? ":" + location.columnNumber : "";
  return location.url + line + column;
}

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function resolveConsoleArgs(
  message: ConsoleMessage,
  entry: ConsoleEntry
): Promise<void> {
  const values = await Promise.allSettled(
    message.args().map((arg) =>
      withTimeout(
        arg.jsonValue(),
        CONSOLE_RESOLVE_TIMEOUT_MS,
        "console argument resolution timed out"
      )
    )
  );
  const resolved = values
    .map((value) =>
      value.status === "fulfilled" ? printable(value.value) : "[unavailable]"
    )
    .join(" ");
  if (resolved) entry.text = resolved.slice(0, 800);
}

function formatConsoleEntry(entry: ConsoleEntry): string {
  const location = entry.location ? " (" + entry.location + ")" : "";
  return "[" + entry.level + "] " + entry.text + location;
}

function levelTexts(
  entries: ConsoleEntry[],
  level: ConsoleEntry["level"]
): string[] {
  return entries
    .filter((entry) => entry.level === level)
    .map(formatConsoleEntry)
    .slice(0, 30);
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function previewUnavailable(error: unknown): boolean {
  return /ERR_CONNECTION_REFUSED|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ECONNREFUSED|socket hang up/i.test(
    errorText(error)
  );
}

async function closeBrowser(browser: Browser): Promise<void> {
  await withTimeout(
    browser.close().catch(() => undefined),
    BROWSER_CLOSE_TIMEOUT_MS,
    "browser close timed out"
  ).catch(() => undefined);
}

async function waitForPageToSettle(
  page: Page,
  navigationCompletedAt: number
): Promise<void> {
  const deadline = navigationCompletedAt + PAGE_SETTLE_TIMEOUT_MS;
  let previousState = "";
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    const state = await withTimeout(
      page.evaluate(() => {
        const browser = globalThis as unknown as {
          location: { href: string };
          document: {
            readyState: string;
            body?: { innerText?: string; innerHTML: string };
            querySelectorAll(selector: string): { length: number };
          };
        };
        const { document, location } = browser;
        const body = document.body;
        return [
          location.href,
          document.readyState,
          body?.innerText ?? "",
          body?.innerHTML.length ?? 0,
          document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]')
            .length,
        ].join("\n");
      }),
      PAGE_OPERATION_TIMEOUT_MS,
      "page stability check timed out"
    ).catch(() => null);

    if (state !== null && state !== previousState) {
      previousState = state;
      stableSince = Date.now();
    }
    const now = Date.now();
    if (
      state !== null &&
      now - navigationCompletedAt >= PAGE_SETTLE_MIN_MS &&
      now - stableSince >= PAGE_STABLE_WINDOW_MS
    ) {
      return;
    }
    await page.waitForTimeout(
      Math.min(PAGE_SETTLE_POLL_MS, Math.max(0, deadline - now))
    );
  }
}

async function auditPage(page: Page): Promise<BrowserAudit> {
  return page.evaluate(() => {
    // esbuild's keepNames transform (tsx uses it by default) rewrites every
    // named inner function below into __name(fn, "fn"). That helper lives at
    // module scope in Node — the browser only receives this function's source,
    // so without a local __name the whole evaluate dies with a ReferenceError
    // and the page's evidence is lost. Defining it here makes the body immune
    // to the transpiler regardless of build flags.
    const host = globalThis as unknown as { __name?: <T>(value: T) => T };
    host.__name ??= (value) => value;
    type BrowserElement = {
      tagName: string;
      innerText?: string;
      textContent?: string | null;
      id: string;
      complete?: boolean;
      naturalWidth?: number;
      currentSrc?: string;
      src?: string;
      getAttribute(name: string): string | null;
      hasAttribute(name: string): boolean;
      getBoundingClientRect(): {
        x: number;
        y: number;
        left: number;
        right: number;
        width: number;
        height: number;
      };
    };
    const browser = globalThis as unknown as {
      document: {
        title: string;
        body?: { innerText?: string };
        documentElement: { scrollWidth: number };
        images: BrowserElement[];
        querySelector(selector: string): BrowserElement | null;
        querySelectorAll(selector: string): BrowserElement[];
      };
      CSS: { escape(value: string): string };
      innerWidth: number;
      getComputedStyle(element: BrowserElement): {
        display: string;
        visibility: string;
        opacity: string;
      };
    };
    const { document, CSS, innerWidth, getComputedStyle } = browser;
    const visible = (element: BrowserElement) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const label = (element: BrowserElement) =>
      (
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.innerText ||
        element.textContent ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
    const issues: string[] = [];
    const interactive: string[] = [];
    const controls = [
      ...document.querySelectorAll(
        "button, a[href], input, select, textarea, [role=button], [tabindex]"
      ),
    ].filter(visible);
    for (const element of controls.slice(0, 80)) {
      const rect = element.getBoundingClientRect();
      const name = label(element);
      interactive.push(
        `${element.tagName.toLowerCase()}${name ? ` “${name.slice(0, 90)}”` : ""} ` +
          `(${Math.round(rect.x)},${Math.round(rect.y)} ` +
          `${Math.round(rect.width)}×${Math.round(rect.height)})`
      );
      if (!name && !["INPUT", "SELECT", "TEXTAREA"].includes(element.tagName)) {
        issues.push(
          `Unnamed interactive element: <${element.tagName.toLowerCase()}>`
        );
      }
      if (rect.width < 24 || rect.height < 24) {
        issues.push(
          `Small interaction target: ${name || element.tagName.toLowerCase()} ` +
            `is ${Math.round(rect.width)}×${Math.round(rect.height)}`
        );
      }
      if (rect.left < -1 || rect.right > innerWidth + 1) {
        issues.push(
          `Horizontally clipped control: ${name || element.tagName.toLowerCase()}`
        );
      }
    }
    for (const input of [
      ...document.querySelectorAll("input, select, textarea"),
    ].filter(visible)) {
      const id = input.getAttribute("id");
      const named =
        input.getAttribute("aria-label") ||
        input.getAttribute("aria-labelledby") ||
        input.getAttribute("placeholder") ||
        (id && document.querySelector(`label[for="${CSS.escape(id)}"]`));
      if (!named) {
        issues.push(
          `Unlabelled form field: <${input.tagName.toLowerCase()}>`
        );
      }
    }
    for (const image of [...document.images].filter(visible)) {
      if (!image.complete || image.naturalWidth === 0) {
        issues.push(
          `Broken image: ${image.currentSrc || image.src || "(no source)"}`
        );
      }
      if (!image.hasAttribute("alt")) {
        issues.push(
          `Image missing alt text: ${image.currentSrc || image.src || "(no source)"}`
        );
      }
    }
    const ids = new Map<string, number>();
    for (const element of document.querySelectorAll("[id]")) {
      ids.set(element.id, (ids.get(element.id) ?? 0) + 1);
    }
    for (const [id, count] of ids) {
      if (count > 1) issues.push(`Duplicate id “${id}” appears ${count} times`);
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) {
      issues.push(
        `Horizontal page overflow: ${document.documentElement.scrollWidth}px document in ${innerWidth}px viewport`
      );
    }
    const headings = [
      ...document.querySelectorAll("h1, h2, h3, h4, h5, h6"),
    ]
      .filter(visible)
      .slice(0, 40)
      .map(
        (heading) =>
          `${heading.tagName}: ${label(heading).slice(0, 140)}`
      );
    return {
      title: document.title,
      text: (document.body?.innerText ?? "")
        .replace(/\n{3,}/g, "\n\n")
        .slice(0, 6000),
      headings,
      interactive,
      issues: [...new Set(issues)].slice(0, 120),
    };
  });
}

export function registerPreviewReviewTools(
  registry: ToolRegistry,
  workspaceRoot: string
): void {
  registry.register(
    "preview_review",
    async (input: PreviewReviewInput, ctx) => {
      const target = localPreviewUrl(input.url);
      let browser: Browser;
      try {
        browser = await launchBrowser();
      } catch (error) {
        return {
          status: "failed",
          decision: "report-tool-error-and-skip",
          requestedUrl: target.href,
          message:
            "Preview debugging could not start. Report this error to the user and skip preview review.",
          error: errorText(error),
        };
      }
      const closeOnAbort = () => void closeBrowser(browser);
      ctx.signal.addEventListener("abort", closeOnAbort, { once: true });
      try {
        const reviews: ViewportReview[] = [];
        const reviewDir = path.join(workspaceRoot, ".atelier", "reviews");
        await mkdir(reviewDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");

        for (const viewport of VIEWPORTS) {
          if (ctx.signal.aborted) throw new Error("Preview review cancelled");
          ctx.emitOutput(
            `Reviewing ${target.href} at ${viewport.width}×${viewport.height}…\n`
          );
          const page = await browser.newPage({
            viewport: { width: viewport.width, height: viewport.height },
          });
          const consoleEntries: ConsoleEntry[] = [];
          const resolving: Array<Promise<void>> = [];
          const pageErrors: string[] = [];
          const failedRequests: string[] = [];
          page.on("console", (message) => {
            if (consoleEntries.length >= MAX_CONSOLE_ENTRIES) return;
            const entry: ConsoleEntry = {
              level: consoleLevel(message.type()),
              text: message.text().slice(0, 800),
              location: formatLocation(message.location()),
            };
            consoleEntries.push(entry);
            // console.log(someObject) arrives as the literal "JSHandle@object",
            // which tells the reader nothing. Pull the real values for exactly
            // those messages; everything else already reads correctly.
            if (entry.text.includes("JSHandle@")) {
              resolving.push(resolveConsoleArgs(message, entry));
            }
          });
          page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 500)));
          page.on("requestfailed", (request) => {
            failedRequests.push(
              `${request.method()} ${request.url()} — ${request.failure()?.errorText ?? "failed"}`
            );
          });
          // A 404 for a chunk or an API 500 never fires requestfailed — the
          // request succeeded, the answer was an error. DevTools shows these in
          // the console, so a review that ignores them misses the usual cause
          // of a blank panel.
          page.on("response", (response) => {
            if (response.status() >= 400) {
              failedRequests.push(
                `${response.status()} ${response.request().method()} ${response.url()}`
              );
            }
          });

          const response = await page.goto(target.href, {
            waitUntil: "domcontentloaded",
            timeout: NAVIGATION_TIMEOUT_MS,
          });
          const navigationCompletedAt = Date.now();
          await page
            .waitForLoadState("networkidle", { timeout: 2_500 })
            .catch(() => undefined);
          await waitForPageToSettle(page, navigationCompletedAt);
          const liveUrl = localPreviewUrl(page.url()).href;
          const audit = await withTimeout(
            auditPage(page),
            PAGE_OPERATION_TIMEOUT_MS,
            "DOM audit timed out"
          );
          const fileName = `${stamp}-${viewport.name}.png`;
          await page.screenshot({
            path: path.join(reviewDir, fileName),
            fullPage: true,
            animations: "disabled",
            timeout: PAGE_OPERATION_TIMEOUT_MS,
          });
          // Object-valued console messages are useful debugging evidence, but
          // a hostile JSHandle must never hold the whole task open.
          await withTimeout(
            Promise.allSettled(resolving),
            PAGE_OPERATION_TIMEOUT_MS,
            "console capture timed out"
          ).catch(() => undefined);
          reviews.push({
            ...viewport,
            url: liveUrl,
            status: response?.status() ?? null,
            screenshot: `.atelier/reviews/${fileName}`,
            audit,
            console: consoleEntries.map(formatConsoleEntry),
            consoleErrors: levelTexts(consoleEntries, "error"),
            consoleWarnings: levelTexts(consoleEntries, "warning"),
            pageErrors: [...new Set(pageErrors)].slice(0, 30),
            failedRequests: [...new Set(failedRequests)].slice(0, 30),
          });
          await withTimeout(
            page.close().catch(() => undefined),
            BROWSER_CLOSE_TIMEOUT_MS,
            "page close timed out"
          ).catch(() => undefined);
        }

        const totals = reviews.reduce(
          (sum, review) => ({
            consoleErrors: sum.consoleErrors + review.consoleErrors.length,
            consoleWarnings: sum.consoleWarnings + review.consoleWarnings.length,
            pageErrors: sum.pageErrors + review.pageErrors.length,
            failedRequests: sum.failedRequests + review.failedRequests.length,
          }),
          { consoleErrors: 0, consoleWarnings: 0, pageErrors: 0, failedRequests: 0 }
        );
        const consoleClean =
          totals.consoleErrors === 0 &&
          totals.consoleWarnings === 0 &&
          totals.pageErrors === 0 &&
          totals.failedRequests === 0;
        return {
          status: consoleClean ? "ready" : "issues",
          decision: consoleClean
            ? "continue"
            : "report-diagnostics-then-fix-or-skip",
          requestedUrl: target.href,
          browser: "Playwright Chromium (headless)",
          reviewedAt: Date.now(),
          message: consoleClean
            ? "Preview is running and its browser diagnostics are clean."
            : "Preview browser diagnostics found runtime failures. Report the exact evidence, then fix it when edits are allowed or skip the review.",
          totals,
          consoleClean,
          debug: {
            console: [...new Set(reviews.flatMap((review) => review.console))],
            consoleErrors: [
              ...new Set(reviews.flatMap((review) => review.consoleErrors)),
            ],
            consoleWarnings: [
              ...new Set(reviews.flatMap((review) => review.consoleWarnings)),
            ],
            pageErrors: [
              ...new Set(reviews.flatMap((review) => review.pageErrors)),
            ],
            failedRequests: [
              ...new Set(reviews.flatMap((review) => review.failedRequests)),
            ],
          },
          viewports: reviews,
        };
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        const unavailable = previewUnavailable(error);
        return {
          status: unavailable ? "unavailable" : "failed",
          decision: unavailable
            ? "ask-user-to-start-preview"
            : "report-tool-error-and-skip",
          requestedUrl: target.href,
          message: unavailable
            ? "No Page preview is responding at this URL. Ask the user to start or reopen Page preview, then stop; do not retry and do not start a server yourself."
            : "Preview debugging failed before a complete audit. Report this error to the user and skip preview review.",
          error: errorText(error),
        };
      } finally {
        ctx.signal.removeEventListener("abort", closeOnAbort);
        await closeBrowser(browser);
      }
    }
  );
}

function localPreviewUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("preview_review requires a valid Page preview URL");
  }
  const local =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (!local || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error("preview_review only accepts local http(s) Page preview URLs");
  }
  return url;
}

async function launchBrowser(): Promise<Browser> {
  const executablePath = process.env.ATELIER_PLAYWRIGHT_EXECUTABLE?.trim();
  const attempts: Array<{ label: string; options: LaunchOptions }> = [];
  if (executablePath) {
    attempts.push({
      label: executablePath,
      options: {
        executablePath,
        headless: true,
        timeout: BROWSER_LAUNCH_TIMEOUT_MS,
      },
    });
  }
  const channels =
    process.platform === "win32"
      ? ["chrome", "msedge"]
      : process.platform === "darwin"
        ? ["chrome", "msedge"]
        : ["chrome", "msedge"];
  for (const channel of channels) {
    attempts.push({
      label: channel,
      options: { channel, headless: true, timeout: BROWSER_LAUNCH_TIMEOUT_MS },
    });
  }
  attempts.push({
    label: "bundled Chromium",
    options: { headless: true, timeout: BROWSER_LAUNCH_TIMEOUT_MS },
  });

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      return await chromium.launch(attempt.options);
    } catch (error) {
      errors.push(`${attempt.label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  throw new Error(
    "No Chromium browser was available for preview_review. Install Chrome or Edge, " +
      "or set ATELIER_PLAYWRIGHT_EXECUTABLE. " +
      errors.join(" | ")
  );
}
