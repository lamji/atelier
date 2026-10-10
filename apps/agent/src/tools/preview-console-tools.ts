import type { PreviewConsoleEntry } from "@atelier/protocol";
import type { ToolRegistry } from "./registry.js";
import type { PreviewCaptureBroker } from "../preview/preview-capture-broker.js";

export interface PreviewConsoleInput {
  /** The route to read; omit for whatever Page preview currently shows. */
  url?: string;
}

const MAX_ENTRIES = 60;

/**
 * Reads the in-app Page preview's own DevTools console, live, signed in as
 * the user.
 *
 * This is the cheapest way to OBSERVE a front-end failure: no headless
 * browser, no separate login, no redirect to /auth — the console the user
 * is already looking at, on demand. It exists because the run this whole
 * change is about kept trying to see the failure through `preview_review`,
 * which opened its own browser and landed on the login wall every time.
 */
export function registerPreviewConsoleTools(
  registry: ToolRegistry,
  broker: PreviewCaptureBroker
): void {
  registry.register(
    "preview_console",
    async (input: PreviewConsoleInput, ctx) => {
      const answer = await broker.request(
        ctx.taskId,
        input.url ?? null,
        ctx.signal
      );
      if (!answer.capture) {
        return {
          status: "unavailable",
          decision: "report-and-try-another-observation",
          message:
            (answer.reason ?? "No Page preview console was available.") +
            " Reproduce the failure another way: preview_review on the route, " +
            "curl/Invoke-RestMethod against the exact request and read the " +
            "status and body, run the failing test, or read the server log.",
        };
      }
      const capture = answer.capture;
      const entries = capture.console.slice(-MAX_ENTRIES);
      const errors = entries.filter((entry) => entry.level === "error");
      const warnings = entries.filter((entry) => entry.level === "warning");
      const failing = errors.length > 0;
      return {
        status: failing ? "issues" : "clean",
        decision: failing
          ? "trace-these-errors-then-fix"
          : "no-console-errors-observed",
        url: capture.url,
        title: capture.title,
        capturedAt: capture.capturedAt,
        counts: {
          errors: errors.length,
          warnings: warnings.length,
          total: entries.length,
        },
        console: entries.map(formatEntry),
        consoleErrors: errors.map(formatEntry),
        message: failing
          ? "The live preview console shows errors — trace these before editing."
          : "The live preview console has no errors. If the failure is not a " +
            "console error, observe it another way (the failing request's " +
            "response body, a failing test, the server log) before editing.",
      };
    }
  );
}

function formatEntry(entry: PreviewConsoleEntry): string {
  const where = entry.source
    ? ` (${entry.source}${entry.line !== null ? ":" + entry.line : ""})`
    : "";
  return `[${entry.level}] ${entry.message}${where}`;
}
