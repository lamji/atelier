import { PreviewTestCase } from "@atelier/protocol";
import type { PreviewTestStepResult } from "@atelier/protocol";
import type { ToolRegistry } from "./registry.js";
import type { PreviewTestBroker } from "../preview/preview-test-broker.js";
import type { PreviewBaselines } from "../context/preview/preview-baselines.js";

/**
 * Runs an authored frontend test case against the LIVE in-app Page preview.
 *
 * This replaces "screenshot, then guess" with a real test: the agent writes
 * the steps for the requested change — navigate, click, fill, wait, assert —
 * and they run against the browser the user is already looking at, signed in
 * and loaded, driven through the desktop bridge. Fast (no external Chromium,
 * no login redirect) and truthful (the verdict is the assertions, not a
 * screenshot read).
 */
export function registerPreviewTestTools(
  registry: ToolRegistry,
  broker: PreviewTestBroker,
  deps: {
    /**
     * What the page showed when the turn was sent, before any edit. An
     * assertion on text that was already there proves nothing about the
     * change; the tool says so instead of returning a clean PASS.
     */
    baselines?: PreviewBaselines;
  } = {}
): void {
  registry.register("preview_test", async (input: unknown, ctx) => {
    const parsed = PreviewTestCase.safeParse(input);
    if (!parsed.success) {
      return {
        status: "invalid",
        decision: "fix-the-test-case-and-retry",
        message:
          "The test case did not validate. Provide { title, steps: [...] } " +
          "where each step is one of navigate | click | fill | press | " +
          "waitFor | assert | screenshot, and include at least one assert " +
          "step that checks the requested outcome.",
        error: parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      };
    }
    const test = parsed.data;
    const answer = await broker.run(
      ctx.taskId,
      { title: test.title, url: test.url ?? null, steps: test.steps },
      ctx.signal
    );
    if (!answer.report) {
      return {
        status: "unavailable",
        decision: "report-and-try-another-observation",
        message:
          (answer.reason ?? "The preview test could not run.") +
          " Open Page preview on the route under review, or observe the " +
          "failure another way (preview_console, curl the request, the " +
          "failing unit test).",
      };
    }
    const report = answer.report;
    const failedSteps = report.steps.filter(
      (step) => !step.ok && step.action !== "screenshot"
    );
    // A passing assertion on text the page ALREADY showed when the turn
    // was sent is not evidence of the change. One turn "verified" a label
    // fix by asserting the account id was visible — it had been all along —
    // and the plan went green on nothing.
    const tautology =
      report.status === "passed" && deps.baselines
        ? preexistingAssertions(
            test.steps as unknown as Array<Record<string, unknown>>,
            ctx.taskId,
            deps.baselines
          )
        : null;
    const tautological = tautology !== null && tautology.all;
    return {
      status: report.status,
      decision:
        report.status !== "passed"
          ? "requested-outcome-not-verified"
          : tautological
            ? "requested-outcome-not-distinguished"
            : "requested-outcome-verified",
      title: report.title,
      url: report.url,
      assertions: report.assertions,
      failed: failedSteps.map(describeFailure),
      steps: report.steps.map(describeStep),
      consoleErrors: report.consoleErrors.slice(0, 20),
      screenshots: report.steps
        .filter((step) => step.screenshotPath)
        .map((step) => step.screenshotPath),
      ...(tautology && tautology.texts.length > 0
        ? { alreadyPresentBeforeEdit: tautology.texts, tautological }
        : {}),
      message:
        report.status !== "passed"
          ? `The test failed: ${report.reason} Report the failing step(s) and ` +
            "FAIL — the requested outcome was not verified."
          : tautological
            ? "The steps passed, but every asserted text was ALREADY on the " +
              "page when this turn was sent (" +
              tautology!.texts.map((t) => `"${t}"`).join(", ") +
              "). This does not verify your change. Assert the NEW text or " +
              "state the change introduces, then report."
            : `The test passed: ${report.reason} Report PASS only if this is the ` +
              "outcome the user asked for.",
    };
  });
}

/**
 * Which visible-text assertions were already true before the turn's edits.
 * `all` is only meaningful when at least one such assertion exists.
 */
function preexistingAssertions(
  steps: Array<Record<string, unknown>>,
  taskId: string,
  baselines: PreviewBaselines
): { texts: string[]; all: boolean } {
  const asserted = steps.filter(
    (step) =>
      step.action === "assert" &&
      typeof step.text === "string" &&
      step.text.trim() &&
      step.visible !== false
  );
  const texts = asserted
    .map((step) => String(step.text))
    .filter((text) => baselines.had(taskId, text));
  return { texts, all: asserted.length > 0 && texts.length === asserted.length };
}

function describeStep(step: PreviewTestStepResult): string {
  const mark = step.ok ? "PASS" : "FAIL";
  return `${mark} [${step.index}] ${step.label}` + (step.error ? ` — ${step.error}` : "");
}

function describeFailure(step: PreviewTestStepResult): string {
  return `[${step.index}] ${step.label}: ${step.error ?? "failed"}`;
}
