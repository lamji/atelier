import assert from "node:assert/strict";
import type { HookConfig } from "@atelier/protocol";
import { EventBus } from "../events/event-bus.js";
import {
  DebugProtocolGuard,
  DEBUG_PROTOCOL_HOOK_ID,
  DEBUG_PROTOCOL_HOOK_NAME,
  instrumentationDelta,
  classifyEvidence,
  needsIsolation,
  statusIn,
} from "./debug-protocol-guard.js";
import {
  assertsDefinitiveCause,
  isHedged,
  looksLikeBugReport,
  looksLikeCopyComplaint,
  looksLikeDiagnosticQuestion,
  looksLikeSpec,
  pastedEvidence,
  symptomOf,
} from "./bug-report.js";

const hook: HookConfig = {
  id: DEBUG_PROTOCOL_HOOK_ID,
  name: DEBUG_PROTOCOL_HOOK_NAME,
  enabled: true,
  event: "preTool",
  matcher: "write_file|replace_code|replace_many",
  action: "block",
};

function editCtx(taskId: string, path = "src/api.ts") {
  return {
    toolName: "replace_code",
    input: { path, oldString: "return a;", newString: "return b;" },
    taskId,
    hook,
  };
}

function bus(): { bus: EventBus; blocked: string[] } {
  const eventBus = new EventBus();
  const blocked: string[] = [];
  eventBus.subscribe((event) => {
    if (event.topic === "hook.blocked") {
      blocked.push((event.payload as { reason: string }).reason);
    }
  });
  return { bus: eventBus, blocked };
}

// ---------------------------------------------------------- bug-report

function testBugReportDetection(): void {
  assert.ok(looksLikeBugReport("the alert shows Something went wrong instead of the real error"));
  assert.ok(looksLikeBugReport("I can't create a budget"));
  assert.ok(looksLikeBugReport("still getting the 500"));
  assert.ok(looksLikeBugReport("fix this", { hasImages: true }), "fix + screenshot is a bug");
  assert.ok(!looksLikeBugReport("add a dark mode toggle to the header"));
  assert.ok(!looksLikeBugReport("implement pagination for the users list"));
  // A written spec is a design, not a failure — even one whose last line
  // says "to avoid regression bugs". This prompt armed the guard for real.
  const spec = [
    "here what i need, tree sitter, in app rag and in app mcp",
    "- tree sitter will be use to index the code repo",
    "-- this will trigger in app load",
    "-- it has a watcher to keep tree sitter updated",
    "-- it has an mcp with rag to retrive file tree needed only for task",
    "---- prmpts -> rag query -> ai run radius impact using tree sitter" +
      "[to avoide regression bugs] -> edt ->verify",
  ].join("\n");
  assert.ok(looksLikeSpec(spec), "a bulleted design is a spec");
  assert.ok(!looksLikeBugReport(spec), "a spec never arms observe-before-fix");
  assert.ok(!looksLikeDiagnosticQuestion(spec));
  assert.ok(looksLikeSpec("here's what I need: a settings page"));
  assert.ok(!looksLikeBugReport("we need to avoid regressions in checkout"));
  assert.ok(
    looksLikeBugReport("this is a regression, the total was right yesterday"),
    "a regression that happened is still a symptom"
  );
  assert.ok(
    looksLikeBugReport(
      ["- steps to reproduce", "- open the page", "- TypeError: x is not a function"].join("\n")
    ),
    "a list with pasted runtime evidence is a bug report"
  );
  assert.ok(
    !looksLikeBugReport("then?"),
    "a bare follow-up with no carried symptom is not a bug report"
  );
  assert.ok(
    looksLikeBugReport("then?", { carriedSymptom: "cannot create budget" }),
    "a follow-up continues an open bug thread"
  );

  // The hidden preview blob must not arm a plain feature ask.
  const withPreview =
    "add a settings page\n<atelier-hidden-context>\nRuntime errors are present.\n</atelier-hidden-context>";
  assert.ok(!looksLikeBugReport(withPreview), "hidden context does not arm a feature ask");

  assert.equal(
    symptomOf("the page is blank\nand the console shows a 500 error"),
    "and the console shows a 500 error"
  );
  assert.ok(pastedEvidence("boom\n[ERROR] 17:41 Unable to compile\nok"));
  assert.equal(pastedEvidence("just a normal sentence about errors in theory"), null);
}

function testCopyComplaint(): void {
  const preview = "Dashboard\nSave changes\nYour budget is ready\nLog out";

  // The quoted text is on the page, and nothing else reads as a failure.
  assert.ok(
    looksLikeCopyComplaint("I still see 'Save changes' on the button, make it Save", preview),
    "quoted on-screen copy + still-see is a copy complaint"
  );
  assert.ok(
    looksLikeCopyComplaint("wrong label: Your budget is ready should say Budget saved", preview),
    "a 3-word phrase of the request that is on screen also qualifies"
  );
  // Runtime vocabulary, a symptom outside the copy family, or text that is
  // NOT on the page keep it a bug report.
  assert.ok(
    !looksLikeCopyComplaint("I still see 'Save changes' and then a 500 error", preview),
    "runtime vocabulary means a real failure"
  );
  assert.ok(
    !looksLikeCopyComplaint("still showing 'Save changes' and the page is broken", preview),
    "a symptom outside the copy family is not a copy complaint"
  );
  assert.ok(
    !looksLikeCopyComplaint("I still see 'Loading…' forever", preview),
    "text that is not on the page cannot be a copy complaint"
  );
  assert.ok(!looksLikeCopyComplaint("I still see 'Save changes'", ""), "no preview, no call");

  // The signal flows through looksLikeBugReport.
  assert.ok(
    !looksLikeBugReport("I still see 'Save changes' on the button", { previewText: preview }),
    "a copy complaint does not arm the debugging protocol"
  );
  assert.ok(
    looksLikeBugReport("I still see 'Save changes' on the button"),
    "without the preview text the symptom still arms"
  );
  assert.ok(
    !looksLikeBugReport("fix this, I still see 'Save changes'", {
      previewText: preview,
      hasImages: true,
    }),
    "a screenshot of copy is still copy"
  );
  // symptomOf is unchanged by the copy signal.
  assert.equal(symptomOf("I still see 'Save changes'"), "I still see 'Save changes'");

  // And the guard's arm() takes the preview text straight through.
  const guard = new DebugProtocolGuard(bus().bus);
  const armed = guard.arm("task-copy", "conv-copy", "I still see 'Save changes' here", {
    previewText: preview,
  });
  assert.equal(armed, null, "a copy complaint does not arm the guard");
}

function testNeedsIsolation(): void {
  assert.ok(needsIsolation("src/api.ts"));
  assert.ok(needsIsolation("src/components/Messages.tsx"));
  assert.ok(!needsIsolation("src/i18n/en.json"), "i18n catalogues");
  assert.ok(!needsIsolation("i18n/en.ts"), "at the workspace root too");
  assert.ok(!needsIsolation("public/locales/en/common.json"), "locales");
  assert.ok(!needsIsolation("src\\locale\\fr.json"), "windows separators");
  assert.ok(!needsIsolation("src/lib/translations.ts"));
  assert.ok(!needsIsolation("src/translation.json"));
  assert.ok(!needsIsolation("src/messages/en.json"));
  assert.ok(needsIsolation("src/messages/index.ts"), "only JSON catalogues under messages/");
}

async function testCatalogueEditSkipsIsolate(): Promise<void> {
  const { bus: eventBus } = bus();
  const guard = new DebugProtocolGuard(eventBus);
  const task = "task-i18n";
  guard.arm(task, "conv-i18n", "the budget page shows Something went wrong");
  guard.note(
    task,
    "run_terminal",
    { command: "curl -s -i http://localhost:5055/api/v1/budgets" },
    { output: "HTTP/1.1 402 Payment Required\n{\"code\":\"BUDGET_ALERT_LIMIT_REACHED\"}", exitCode: 0 }
  );
  const catalogue = await guard.check(editCtx(task, "src/i18n/en.json"));
  assert.equal(catalogue, undefined, "a message catalogue needs no impact_of_edit");
  const code = await guard.check(editCtx(task, "src/api.ts"));
  assert.match(code?.reason ?? "", /ISOLATE before FIX/, "code still does");
  const routes = guard.status("task-unobserved-routes");
  assert.equal(routes.armed, false);
  guard.arm("task-routes", "conv-routes", "the form shows an error on submit");
  const owed = guard.status("task-routes");
  assert.ok(
    owed.lines.some((line) => /preview_test/.test(line)),
    "preview_test is offered as an observation route"
  );
}

// ------------------------------------------------------------- guard

async function testObserveBeforeFix(): Promise<void> {
  const { bus: eventBus, blocked } = bus();
  const guard = new DebugProtocolGuard(eventBus);
  const task = "task-observe";

  const symptom = guard.arm(task, "conv-1", "I can't create a budget, it says Something went wrong");
  assert.ok(symptom, "a failure report arms the guard");

  // Edit before any observation is refused.
  const first = await guard.check(editCtx(task));
  assert.equal(first?.allowed, false);
  assert.match(first?.reason ?? "", /OBSERVE before FIX/);
  assert.equal(blocked.length, 1, "the refusal is visible on the timeline");

  // Instrumentation (a log line) is allowed through before the observation.
  const log = await guard.check({
    toolName: "replace_code",
    input: {
      path: "src/api.ts",
      oldString: "    const res = await post(body);",
      newString: '    console.log("budget resp");\n    const res = await post(body);',
    },
    taskId: task,
    hook,
  });
  assert.equal(log, undefined, "adding a console.log is allowed before observing");

  // A curl that reproduces the failure is the observation.
  guard.note(
    task,
    "run_terminal",
    { command: "curl -s -i http://localhost:5055/api/v1/budgets" },
    { output: "HTTP/1.1 402 Payment Required\n{\"code\":\"BUDGET_ALERT_LIMIT_REACHED\"}", exitCode: 0 }
  );

  // Now the edit is allowed once isolation is satisfied.
  const beforeIsolate = await guard.check(editCtx(task));
  assert.equal(beforeIsolate?.allowed, false, "ISOLATE is still required");
  assert.match(beforeIsolate?.reason ?? "", /ISOLATE before FIX/);

  guard.note(task, "impact_of_edit", { path: "src/api.ts" }, { callers: [] });
  const afterIsolate = await guard.check(editCtx(task));
  assert.equal(afterIsolate, undefined, "observed + isolated edit goes through");

  // After editing, the gate demands a fresh observation before "Fixed".
  guard.noteEdit(task, "src/api.ts");
  let status = guard.status(task);
  assert.ok(status.armed && status.observed);
  assert.ok(
    status.lines.some((line) => /RE-OBSERVE/.test(line)),
    "re-observation is owed after the fix"
  );

  // A clean re-run closes the observation requirement, but the leftover log
  // line still has to come out.
  guard.note(
    task,
    "run_terminal",
    { command: "curl -s -i http://localhost:5055/api/v1/budgets" },
    { output: "HTTP/1.1 201 Created\n{\"id\":\"b_1\"}", exitCode: 0 }
  );
  status = guard.status(task);
  assert.ok(
    status.lines.some((line) => /Remove the temporary log/.test(line)),
    "instrumentation must be removed before reporting"
  );

  // Removing the log line clears the last requirement.
  await guard.check({
    toolName: "replace_code",
    input: {
      path: "src/api.ts",
      oldString: '    console.log("budget resp");\n    const res = await post(body);',
      newString: "    const res = await post(body);",
    },
    taskId: task,
    hook,
  });
  status = guard.status(task);
  assert.equal(status.lines.length, 0, "gate is clear once the log is removed");
}

async function testPastedEvidenceSkipsObservation(): Promise<void> {
  const { bus: eventBus } = bus();
  const guard = new DebugProtocolGuard(eventBus);
  const task = "task-pasted";
  guard.arm(
    task,
    "conv-2",
    "fix this\n[ERROR] 17:41:28 Unhandled Rejection TypeError: x is not a function",
    { requireIsolate: false }
  );
  // The user pasted a stack trace, so the failure is already observed: the
  // first edit goes straight through (no isolation required here).
  const decision = await guard.check(editCtx(task));
  assert.equal(decision, undefined, "pasted runtime evidence counts as the observation");
}

async function testAuthRedirectIsNotEvidence(): Promise<void> {
  const { bus: eventBus } = bus();
  const guard = new DebugProtocolGuard(eventBus);
  const task = "task-auth";
  guard.arm(task, "conv-3", "budget create shows Something went wrong");
  // A curl that comes back 401 saw the login wall, not the symptom.
  guard.note(
    task,
    "run_terminal",
    { command: "curl -s -i http://localhost:5055/api/v1/budgets" },
    { output: "HTTP/1.1 401 Unauthorized\n{\"error\":\"Missing authorization header\"}", exitCode: 0 }
  );
  const decision = await guard.check(editCtx(task));
  assert.equal(decision?.allowed, false, "a 401 is a blocked observation, not the failure");
  assert.match(decision?.reason ?? "", /OBSERVE before FIX/);
}

function testEvidenceClassification(): void {
  assert.equal(statusIn("HTTP/1.1 402 Payment Required"), 402);
  assert.equal(statusIn('{"statusCode":500,"error":"x"}'), 500);
  assert.equal(statusIn("all good, 200 items loaded"), null);

  const preview = classifyEvidence(
    "preview_console",
    {},
    { status: "issues", url: "http://localhost:8080/x", debug: { consoleErrors: ["TypeError: boom"] } },
    "boom"
  );
  assert.ok(preview && "failing" in preview && preview.failing);

  const clean = classifyEvidence(
    "preview_console",
    {},
    { status: "clean", routeReached: true, url: "http://localhost:8080/x" },
    "boom"
  );
  assert.ok(clean && "failing" in clean && !clean.failing);
}

function testInstrumentationDelta(): void {
  const add = instrumentationDelta("replace_code", {
    path: "a.ts",
    oldString: "doWork();",
    newString: 'console.log("here");\ndoWork();',
  });
  assert.equal(add?.get("a.ts"), 1, "one log line added");

  const real = instrumentationDelta("replace_code", {
    path: "a.ts",
    oldString: "return a;",
    newString: "return b;",
  });
  assert.equal(real, null, "a real change is not instrumentation");

  const remove = instrumentationDelta("replace_code", {
    path: "a.ts",
    oldString: 'console.error("x");\ndoWork();',
    newString: "doWork();",
  });
  assert.equal(remove?.get("a.ts"), -1, "removing a log line is negative");

  // A whole-file write is never "just logging".
  assert.equal(
    instrumentationDelta("write_file", { path: "a.ts", content: "console.log(1)" }),
    null
  );
}

async function testUnarmedTaskIsUntouched(): Promise<void> {
  const { bus: eventBus } = bus();
  const guard = new DebugProtocolGuard(eventBus);
  const task = "task-feature";
  const armed = guard.arm(task, "conv-4", "add a CSV export button to the reports page");
  assert.equal(armed, null, "a feature ask does not arm the guard");
  const decision = await guard.check(editCtx(task));
  assert.equal(decision, undefined, "an unarmed task edits freely");
}

function testConclusionDetectors(): void {
  assert.ok(assertsDefinitiveCause("The root cause is a stale entitlement cache."));
  assert.ok(assertsDefinitiveCause("This is happening because the tier isn't refreshed."));
  assert.ok(assertsDefinitiveCause("Fixed it in apiClient.ts."));
  assert.ok(!assertsDefinitiveCause("Here is what the code does."));

  assert.ok(isHedged("This is likely caused by a stale cache."));
  assert.ok(isHedged("My hypothesis is the tier cache, not yet reproduced."));
  assert.ok(!isHedged("The root cause is the stale cache."));

  assert.ok(looksLikeDiagnosticQuestion("why is the budget failing to save?"));
  assert.ok(looksLikeDiagnosticQuestion("what's causing the 500 on create?"));
  assert.ok(!looksLikeDiagnosticQuestion("how do I add a dark mode toggle?"));
  assert.ok(!looksLikeDiagnosticQuestion("what does this function do?"));
}

async function testDiagnoseConclusionGate(): Promise<void> {
  const { bus: eventBus } = bus();
  const guard = new DebugProtocolGuard(eventBus);
  const task = "task-diagnose";
  const armed = guard.arm(task, "conv-d", "why is budget creation failing?", {
    mode: "diagnose",
  });
  assert.ok(armed, "a diagnostic question arms the guard in diagnose mode");

  // A confident, unreproduced verdict is refused.
  let status = guard.status(task, "The root cause is the stale entitlement cache.");
  assert.ok(
    status.lines.some((line) => /definitive cause or fix/.test(line)),
    "a confident unreproduced conclusion is held"
  );

  // A hedged verdict passes.
  status = guard.status(
    task,
    "This is likely the stale entitlement cache, but I haven't reproduced it."
  );
  assert.equal(status.lines.length, 0, "a hedged hypothesis is allowed");

  // Once reproduced, the confident verdict is earned.
  guard.note(
    task,
    "run_terminal",
    { command: "curl -s -i https://dev/api/v1/budgets" },
    { output: "HTTP/1.1 402 Payment Required\n{\"code\":\"BUDGET_ALERT_LIMIT_REACHED\"}", exitCode: 0 }
  );
  status = guard.status(task, "The root cause is the stale entitlement cache.");
  assert.equal(status.lines.length, 0, "a reproduced conclusion stands");

  // A plain how-to question does not arm diagnose mode.
  const notArmed = guard.arm("task-howto", "conv-d2", "how do I add pagination?", {
    mode: "diagnose",
  });
  assert.equal(notArmed, null);
}

async function main(): Promise<void> {
  testBugReportDetection();
  testCopyComplaint();
  testNeedsIsolation();
  await testCatalogueEditSkipsIsolate();
  testConclusionDetectors();
  await testDiagnoseConclusionGate();
  await testObserveBeforeFix();
  await testPastedEvidenceSkipsObservation();
  await testAuthRedirectIsNotEvidence();
  testEvidenceClassification();
  testInstrumentationDelta();
  await testUnarmedTaskIsUntouched();
  console.log("debug-protocol-guard: all assertions passed");
}

void main();
