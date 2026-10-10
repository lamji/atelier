import type {
  PreviewTestStep,
  PreviewTestStepResult,
  PreviewTestReport,
} from "@atelier/protocol";
import { bridge } from "./bridge-client.js";
import {
  currentPreviewUrl,
  captureActivePreviewShot,
  captureActivePreviewConsole,
} from "./preview-context.js";

export interface PreviewTestRequest {
  id: string;
  title: string;
  url: string | null;
  steps: PreviewTestStep[];
}

/** Let a navigate settle before the next step reads the freshly loaded frame. */
const NAVIGATE_SETTLE_MS = 500;

/** Ceiling on how many screenshots one run will persist. */
const MAX_SHOTS = 12;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function stepLabel(step: PreviewTestStep): string {
  switch (step.action) {
    case "navigate":
      return `navigate ${step.target}`;
    case "click":
      return `click ${step.selector ?? JSON.stringify(step.text ?? "")}`;
    case "fill":
      return `fill ${step.selector}`;
    case "press":
      return `press ${step.key}`;
    case "waitFor":
      return `waitFor ${step.selector ?? step.text ?? ""}`.trim();
    case "assert":
      return `assert: ${step.description}`;
    case "screenshot":
      return `screenshot${step.label ? ` ${step.label}` : ""}`;
  }
}

async function saveShot(index: number): Promise<string | undefined> {
  const dataUrl = await captureActivePreviewShot();
  if (!dataUrl) return undefined;
  const path = `.atelier/reviews/preview-test-${Date.now()}-${index}.png`;
  const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
  try {
    await bridge.rpc("fs.writeImage", { path, data, mediaType: "image/png" });
    return path;
  } catch {
    return undefined;
  }
}

/**
 * Runs an authored test case against the LIVE in-app preview iframe, one step
 * at a time through the desktop bridge — the browser the user is already
 * looking at, signed in and loaded, so no external Chromium and no login wall.
 *
 * Stops at the first failing step (a broken assertion, a missing element, a
 * timed-out wait): the steps after it were predicated on it, so running them
 * would only produce noise. Screenshots never fail the run.
 */
export async function runPreviewTest(
  request: PreviewTestRequest
): Promise<{ report: PreviewTestReport } | { reason: string }> {
  const url = request.url ?? currentPreviewUrl();
  if (!url) return { reason: "No Page preview is open to run the test against." };
  const act = window.atelierDesktop?.previewAct;
  if (!act) {
    return { reason: "The preview test bridge is unavailable in this build." };
  }

  const results: PreviewTestStepResult[] = [];
  let assertTotal = 0;
  let assertPassed = 0;
  let shots = 0;
  let stopped = false;

  for (let index = 0; index < request.steps.length; index += 1) {
    const step = request.steps[index]!;
    const label = stepLabel(step);

    if (step.action === "screenshot") {
      const screenshotPath = shots < MAX_SHOTS ? await saveShot(index) : undefined;
      if (screenshotPath) shots += 1;
      results.push({
        index,
        action: step.action,
        label,
        ok: true,
        detail: screenshotPath ? "captured" : "screenshot unavailable",
        ...(screenshotPath ? { screenshotPath } : {}),
      });
      continue;
    }

    if (stopped) {
      results.push({
        index,
        action: step.action,
        label,
        ok: false,
        detail: "skipped — an earlier step failed",
      });
      continue;
    }

    let outcome: { ok: boolean; detail: string; error?: string } | null;
    try {
      outcome = await act(url, step);
    } catch (error) {
      outcome = {
        ok: false,
        detail: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const ok = outcome?.ok === true;
    results.push({
      index,
      action: step.action,
      label,
      ok,
      detail: outcome?.detail ?? "",
      ...(outcome?.error ? { error: outcome.error } : {}),
    });
    if (step.action === "assert") {
      assertTotal += 1;
      if (ok) assertPassed += 1;
    }
    if (!ok) stopped = true;
    if (step.action === "navigate" && ok) await sleep(NAVIGATE_SETTLE_MS);
  }

  // End-of-run evidence, whatever the verdict — the screen as it finished.
  const finalShot = shots < MAX_SHOTS ? await saveShot(request.steps.length) : undefined;
  if (finalShot) {
    results.push({
      index: request.steps.length,
      action: "screenshot",
      label: "final state",
      ok: true,
      detail: "captured",
      screenshotPath: finalShot,
    });
  }

  const consoleResult = await captureActivePreviewConsole(url);
  const consoleErrors =
    "capture" in consoleResult
      ? consoleResult.capture.console
          .filter((entry) => entry.level === "error")
          .map((entry) => entry.message)
      : [];

  const assertFailed = assertTotal - assertPassed;
  const anyStepFailed = results.some(
    (result) => !result.ok && result.action !== "screenshot"
  );
  const status: PreviewTestReport["status"] = anyStepFailed ? "failed" : "passed";
  const reason =
    assertTotal === 0
      ? "No assertion steps were authored — add assert steps that check the requested outcome."
      : status === "passed"
        ? `All ${assertTotal} assertion(s) held.`
        : `${assertFailed} of ${assertTotal} assertion(s) failed.`;

  return {
    report: {
      status,
      title: request.title,
      url,
      steps: results,
      assertions: { total: assertTotal, passed: assertPassed, failed: assertFailed },
      consoleErrors,
      reason,
    },
  };
}
