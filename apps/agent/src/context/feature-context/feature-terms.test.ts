import assert from "node:assert/strict";
import { featureTerms, rankCandidates } from "./feature-context-store.js";

/**
 * The failure this locks down: `/context Budgets and Alerts` reported
 *
 *   No indexed tree-sitter symbol, file, or feature matched every term in
 *   "Budgets and Alerts". This feature may not exist in the workspace…
 *
 * on a workspace where the user was looking straight at the Budgets &
 * Alerts page. Two faults compounded — "and" counted as a required term,
 * and every term had to appear in ONE symbol name or path, which no
 * multi-file product feature can satisfy.
 */
async function main(): Promise<void> {
  // The conjunction is not part of the feature's name.
  assert.deepEqual(featureTerms("Budgets and Alerts"), ["budgets", "alerts"]);
  assert.deepEqual(featureTerms("Contract Management"), [
    "contract",
    "management",
  ]);
  assert.deepEqual(featureTerms("cost analysis for the project"), [
    "cost",
    "analysis",
    "project",
  ]);

  // A name made only of stopwords still searches for what was typed,
  // rather than collapsing to nothing.
  assert.deepEqual(featureTerms("The View"), ["the", "view"]);

  // Digits and underscores survive; one-character noise does not.
  assert.deepEqual(featureTerms("GKE KPI v2"), ["gke", "kpi", "v2"]);

  const files = [
    { path: "src/pages/BudgetsPage.tsx" },
    { path: "src/components/alerts/AlertsList.tsx" },
    { path: "src/pages/BudgetsAndAlerts.tsx" },
    { path: "src/lib/formatCurrency.ts" },
  ];
  const terms = featureTerms("Budgets and Alerts");
  const ranked = rankCandidates(files, (f) => f.path, "Budgets and Alerts", terms);
  const paths = ranked.map((f) => f.path);

  // A feature that SPANS files is found — this is the whole bug.
  assert.ok(
    paths.includes("src/pages/BudgetsPage.tsx"),
    "a file carrying one term still seeds the feature"
  );
  assert.ok(
    paths.includes("src/components/alerts/AlertsList.tsx"),
    "and so does the file carrying the other"
  );
  // Precision comes from ranking: carrying both terms wins.
  assert.equal(
    paths[0],
    "src/pages/BudgetsAndAlerts.tsx",
    "the file carrying both terms ranks first"
  );
  // An unrelated file carrying no term is still excluded.
  assert.ok(
    !paths.includes("src/lib/formatCurrency.ts"),
    "matching nothing is still matching nothing"
  );

  // An exact phrase match outranks a mere term hit.
  const byPhrase = rankCandidates(
    [{ path: "src/x/AlertsList.tsx" }, { path: "contract management" }],
    (f) => f.path,
    "contract management",
    featureTerms("contract management")
  );
  assert.equal(byPhrase[0]?.path, "contract management");
}

void main();
