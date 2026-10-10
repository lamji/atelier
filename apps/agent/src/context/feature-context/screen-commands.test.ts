import assert from "node:assert/strict";
import { entryScore } from "./feature-context-store.js";
import {
  parseEntryPointCommand,
  parseImpactRadiusCommand,
  readScreenEvidence,
  screenTerms,
} from "./screen-commands.js";

/**
 * A send from the composer: the command, then the hidden preview block and
 * the screenshot's source URL that the composer appends to it. This shape
 * is what makes the commands provider-neutral — everything needed is text.
 */
const MARKED_SEND = [
  "/entry_point",
  "",
  "<atelier-hidden-context>",
  "CURRENT PAGE PREVIEW",
  "URL: http://localhost:8080/budgets-and-alerts",
  "",
  "<h1>Budgets &amp; Alerts</h1><h2>Budget Health</h2>",
  "Interactive elements:",
  '- <button> "Create budget"',
  '- <a> "View at risk"',
  "</atelier-hidden-context>",
  "",
  "Screenshot context:",
  "- Current page preview URL: http://localhost:8080/budgets-and-alerts",
].join("\n");

async function main(): Promise<void> {
  // Both spellings, with and without a hint.
  assert.equal(parseEntryPointCommand("/entry_point"), "");
  assert.equal(parseEntryPointCommand("/entry-point"), "");
  assert.equal(parseEntryPointCommand("/entry_point budgets"), "budgets");
  assert.equal(parseEntryPointCommand("/entrypoint  budgets  "), "budgets");
  assert.equal(parseEntryPointCommand("/context login"), undefined);
  assert.equal(parseImpactRadiusCommand("/impact_radius"), "");
  assert.equal(parseImpactRadiusCommand("/impact-radius x"), "x");
  assert.equal(parseImpactRadiusCommand("explain /impact_radius"), undefined);

  // The command is the first line; the evidence below it must survive.
  assert.equal(parseEntryPointCommand(MARKED_SEND), "");

  const evidence = readScreenEvidence(MARKED_SEND);
  assert.equal(evidence.hasPreview, true);
  assert.equal(evidence.route, "http://localhost:8080/budgets-and-alerts");
  // The route is split on separators and stripped of joining words.
  assert.deepEqual(evidence.routeTerms, ["budgets", "alerts"]);
  assert.ok(
    evidence.labels.includes("Budget Health"),
    "headings are read off the captured DOM"
  );
  assert.ok(
    evidence.labels.includes("Create budget"),
    "so are button labels"
  );

  const terms = screenTerms(evidence, "");
  assert.equal(terms[0], "budgets", "route terms lead — the code chose them");
  assert.ok(terms.includes("health"), "page text still contributes");

  // A send with no preview at all degrades to whatever the user typed.
  const bare = readScreenEvidence("/entry_point contract management");
  assert.equal(bare.hasPreview, false);
  assert.equal(bare.route, null);
  assert.deepEqual(screenTerms(bare, "contract management"), [
    "contract",
    "management",
  ]);

  // ── ranking ──────────────────────────────────────────────────────────
  const route = evidence.routeTerms;
  const page = {
    name: "BudgetsAndAlertsPage",
    path: "src/pages/BudgetsAndAlertsPage.tsx",
    kind: "component",
  };
  const helper = {
    name: "formatBudgets",
    path: "src/lib/format.ts",
    kind: "function",
  };
  const test = {
    name: "BudgetsAndAlertsPage",
    path: "src/pages/BudgetsAndAlertsPage.test.tsx",
    kind: "component",
  };

  assert.ok(
    entryScore(page, terms, route) > entryScore(helper, terms, route),
    "a page component outranks a util that merely shares a word"
  );
  assert.equal(
    entryScore(test, terms, route),
    0,
    "a test file is never a screen's entry point"
  );
  assert.equal(
    entryScore({ name: "unrelated", path: "src/x.ts", kind: "function" }, terms, route),
    0,
    "matching nothing scores nothing"
  );

  // A route word counts for more than a word read off the page: the code
  // chose the URL, a designer chose the heading.
  const byRoute = { name: "x", path: "src/budgets/x.ts", kind: "function" };
  const byLabel = { name: "x", path: "src/health/x.ts", kind: "function" };
  assert.ok(
    entryScore(byRoute, terms, route) > entryScore(byLabel, terms, route),
    "route match beats label match"
  );
}

void main();
