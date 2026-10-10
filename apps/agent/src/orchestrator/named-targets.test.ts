import assert from "node:assert/strict";
import { wrapHiddenContext } from "@atelier/shared";
import {
  focusedLiterals,
  previewVisibleText,
  textOfMarkup,
} from "../context/preview/preview-evidence.js";
import { clipKeepingRefs, extractRefs } from "../context/session/clip-keeping-refs.js";
import { classifyChange, classifyFileDiff } from "./change-scale/classify-change.js";
import { promptWithRelevantPreview } from "./llm-request.js";
import { namedTargets, onScreenPhrases } from "./named-targets.js";
import { hasApprovalVerb, isGoAhead, sharesSubject } from "./pipeline-executor.js";
import { turnStance } from "./turn-stance.js";

/** The block shape the renderer emits (see apps/web/src/services/preview-context.ts). */
const PREVIEW = wrapHiddenContext(
  [
    "CURRENT PAGE PREVIEW RUNTIME CONTEXT",
    "URL: http://localhost:8080/workspace?section=budgets",
    "Title: FinOps | DigitalFuture",
    "<focused-elements>",
    "The user highlighted these regions of the screenshot.",
    '- <td> "No budgets configured yet." (html > body > table > td)',
    "</focused-elements>",
    "<interactive-elements>",
    'html > body > button <button> "Create Budget" (10,10 90x30) color=rgb(1,1,1)',
    'html > body > div > button <button> "0193CD-45580A-230516" (5,5 60x20) color=x',
    "</interactive-elements>",
    "<console-diagnostics>",
    "[warning] motion() is deprecated (http://localhost:8080/node_modules/.vite/deps/framer-motion.js)",
    "</console-diagnostics>",
    "<page-html>",
    '<div class="max-w-[180px]"><span>Refresh Cache</span><p>No budgets configured yet.</p></div>',
    "</page-html>",
    "<page-css>",
    ".max-w-\\[180px\\]{max-width:180px}",
    "</page-css>",
  ].join("\n")
);

function main(): void {
  // --- preview evidence -------------------------------------------------
  const visible = previewVisibleText(PREVIEW);
  assert.match(visible, /No budgets configured yet\./);
  assert.match(visible, /Create Budget/);
  assert.match(visible, /Refresh Cache/);
  assert.doesNotMatch(visible, /max-w-\[180px\]/, "classes are not visible text");
  assert.doesNotMatch(visible, /framer-motion/, "console URLs are not visible text");
  assert.deepEqual(focusedLiterals(PREVIEW), ["No budgets configured yet."]);
  assert.equal(textOfMarkup("<b>a &amp; b</b>  <i>c</i>"), "a & b c");

  // --- promptWithRelevantPreview strips markup in the CURRENT layout ----
  const plain = promptWithRelevantPreview("make this descriptive\n\n" + PREVIEW);
  assert.doesNotMatch(plain, /<page-html>/);
  assert.doesNotMatch(plain, /<page-css>/);
  assert.match(plain, /<interactive-elements>/);
  assert.match(plain, /<focused-elements>/);
  const styled = promptWithRelevantPreview("fix the css of this\n\n" + PREVIEW);
  assert.match(styled, /<page-css>/, "a styling request keeps the stylesheet");

  // --- named targets ----------------------------------------------------
  const named = namedTargets({
    humanPrompt:
      "wait you mark it pass? i can still see the No budgets configured yet. " +
      "if the selected billing account doesnt have the budget",
    previewText: visible,
  });
  assert.deepEqual(named.paths, []);
  assert.ok(
    named.literals.some((l) => /^No budgets configured yet/i.test(l)),
    `on-screen phrase named: ${JSON.stringify(named.literals)}`
  );
  assert.ok(
    !named.literals.some((l) => /doesnt have/.test(l)),
    "an apostrophe-free contraction is not a quoted literal"
  );

  const pasted = namedTargets({
    humanPrompt:
      "are considering this solution? 'budgets.table.no_configured': " +
      "'No budgets configured yet in {id}',",
  });
  assert.ok(pasted.literals.includes("budgets.table.no_configured"));
  assert.ok(pasted.literals.includes("No budgets configured yet in {id}"));

  const pathed = namedTargets({
    humanPrompt:
      "go here and find those label finops-crystal-lens\\src\\i18n\\translations.ts:970 " +
      "see http://localhost:8080/workspace?x=1 and dev.spndx.ai",
  });
  assert.deepEqual(pathed.paths, ["finops-crystal-lens\\src\\i18n\\translations.ts"]);
  assert.ok(!pathed.literals.includes("dev.spndx.ai"), "hosts are not keys");

  const focused = namedTargets({
    humanPrompt: "i need this descriptive, include the name and fallback to id",
    previewText: visible,
    focused: focusedLiterals(PREVIEW),
  });
  assert.equal(focused.literals[0], "No budgets configured yet.");

  assert.deepEqual(
    onScreenPhrases("please fix the Create Budget button", "Create Budget\nRefresh"),
    ["Create Budget"]
  );
  assert.deepEqual(onScreenPhrases("in the of the", "in the of the"), []);

  // --- turn stance ------------------------------------------------------
  assert.equal(
    turnStance({ humanPrompt: "Implement it", previousStatus: "cancelled" }).stance,
    "continue"
  );
  assert.equal(
    turnStance({ humanPrompt: "add a refresh button", previousStatus: "completed" })
      .stance,
    "fresh"
  );
  assert.equal(
    turnStance({
      humanPrompt: "wait you mark it pass? i can still see the old label",
      previousStatus: "completed",
    }).stance,
    "correct"
  );
  assert.equal(
    turnStance({ humanPrompt: "now fix the toast", previousStatus: "cancelled" }).stance,
    "correct"
  );
  assert.equal(
    turnStance({
      humanPrompt: "now you are fixing the wrong file again, go here: a/b.ts",
      previousStatus: "completed",
    }).stance,
    "correct"
  );

  // --- the hand-off's approval detection --------------------------------
  const plan =
    "1. Read src/i18n/translations.ts:970\n2. Pass the account label at " +
    "src/components/budgets/BudgetsTable.tsx:559";
  assert.ok(
    hasApprovalVerb(
      "Implmenet and i am expecting the ixed version because all you said from plan is clear"
    ),
    "a misspelled 'implement' is still an approval"
  );
  assert.ok(!hasApprovalVerb("add a footer to the login page"));
  assert.ok(!hasApprovalVerb("the implementation is slow"));
  assert.ok(isGoAhead("implement it", plan));
  assert.ok(isGoAhead("ok, proceed with the translations change", plan));
  assert.ok(
    !isGoAhead("implement the checkout page", plan),
    "an approval-shaped request about something else is not a go-ahead"
  );
  assert.ok(sharesSubject("fix the translations first", plan));
  assert.ok(!sharesSubject("add a footer", plan));

  // --- ref-preserving clip ---------------------------------------------
  const answer =
    "Plan: get the id from BillingAccountContext. " +
    "The text lives in finops-crystal-lens/src/i18n/translations.ts:970 and is " +
    "rendered by src/components/budgets/BudgetsTable.tsx:559 through t('x'). " +
    "Then run the targeted tests and verify the account's budget appears " +
    "instead of the empty-state text. No edits made yet.";
  assert.deepEqual(extractRefs(answer), [
    "finops-crystal-lens/src/i18n/translations.ts:970",
    "src/components/budgets/BudgetsTable.tsx:559",
  ]);
  const clipped = clipKeepingRefs(answer, 160);
  assert.ok(clipped.length <= 160, `clip respects the cap: ${clipped.length}`);
  assert.match(clipped, /\[refs: .*translations\.ts:970.*BudgetsTable\.tsx:559\]/);
  assert.equal(clipKeepingRefs("short", 100), "short");

  // --- change scale -----------------------------------------------------
  const copyDiff = [
    "diff --git a/src/i18n/translations.ts b/src/i18n/translations.ts",
    "--- a/src/i18n/translations.ts",
    "+++ b/src/i18n/translations.ts",
    "@@ -969,3 +969,3 @@",
    "     'budgets.table.count_of': '{filtered} of {total} budgets',",
    "-    'budgets.table.no_configured': 'No budgets configured yet.',",
    "+    'budgets.table.no_configured': 'No budgets configured yet in {id}',",
    "     'budgets.table.no_match': 'No budgets match your filters.',",
  ].join("\n");
  assert.equal(classifyFileDiff(copyDiff), 1);
  assert.equal(classifyChange([{ path: "src/i18n/translations.ts", diff: copyDiff }]), "copy");
  const jsxDiff = [
    "@@ -1,3 +1,3 @@",
    "   <p>",
    "-    No budgets configured yet.",
    "+    No budgets configured yet in {label}",
    "   </p>",
  ].join("\n");
  assert.equal(classifyFileDiff(jsxDiff), null, "an interpolation is code, not copy");
  const codeDiff = [
    "@@ -1,2 +1,3 @@",
    "-export function useBudgets() {",
    "+export function useBudgets(selected?: string | null) {",
    "+  const id = selected ?? null;",
  ].join("\n");
  assert.equal(classifyChange([{ path: "src/hooks/useBudgets.ts", diff: codeDiff }]), "code");
  assert.equal(classifyChange([{ path: ".env", diff: "-A=1\n+A=2" }]), "inert");
  assert.equal(classifyChange([]), "code");

  console.log("named-targets / preview-evidence / stance / clip / scale: ok");
}

main();
