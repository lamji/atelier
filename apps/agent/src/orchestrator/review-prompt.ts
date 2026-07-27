import type { CloneHit } from "../knowledge/impact/clone-scan.js";

export interface ReviewInputs {
  changedFiles: string[];
  similar: CloneHit[];
  companionFiles: string[];
}

/**
 * The independent-review turn. Runs in a FRESH session with no memory of
 * writing the change and no edit tools, so it cannot rubber-stamp its own
 * work — it targets a defect class that compilers, linters and tests
 * cannot see, and that human PR review keeps catching:
 *
 *  - the same pattern fixed in one file and left in its twin (the vector
 *    sweep supplies the twins, since no import edge connects them);
 *  - UI/branch states that can never occur because the condition that
 *    would produce them does not exist (companion files supply the other
 *    half of the component);
 *  - global reach — document/window queries that escape the component.
 *
 * It must end with a machine-parseable VERDICT_JSON line so the pipeline
 * can gate on pass/fail instead of trusting prose.
 */
export interface ReviewFixInputs {
  /** The reviewer's findings, verbatim. */
  findings: string[];
  /** Files the task changed — where the defects live. */
  changedFiles: string[];
  /** The user's original request, so the repair stays in scope. */
  request: string;
  /** Which repair round this is, and how many the pipeline allows. */
  attempt: number;
  maxAttempts: number;
}

/**
 * The repair turn after a failed review. Runs in the IMPLEMENTER session
 * (it wrote the change and knows why), but a finding sentence alone is not
 * enough to act on: it names a defect, not a location, and the session's
 * memory of the file may be several edits stale. So the prompt re-states
 * the files in play, the original request the repair must not break, and
 * that a fresh reviewer will check the result — the difference between
 * "fix it" and a fix that survives the next review.
 */
export function buildReviewFixPrompt(inputs: ReviewFixInputs): string {
  const lines: string[] = [
    `An INDEPENDENT reviewer rejected your change (repair round ` +
      `${inputs.attempt} of ${inputs.maxAttempts}). Every finding below is a ` +
      "real defect in code you just wrote. Fix them now, then stop.",
    "",
    "FINDINGS TO FIX:",
    ...inputs.findings.map((f, i) => `${i + 1}. ${f}`),
    "",
    "Files your change touched (the defects are in these, or in what they " +
      "talk to):",
    ...inputs.changedFiles.slice(0, 30).map((f) => `- ${f}`),
    "",
    "The original request, which must still be satisfied when you are done:",
    inputs.request.length > 1200
      ? `${inputs.request.slice(0, 1200)}…`
      : inputs.request,
    "",
    "HOW TO REPAIR:",
    "- Re-read each file before editing it. Your memory of it is stale — " +
      "it has been edited since, possibly by an earlier repair round.",
    "- Fix the CAUSE the finding names, not the symptom. If a finding says " +
      "a value serializes wrong, fix the value's type/representation at the " +
      "source rather than patching one consumer.",
    "- If a finding names dead or leftover code, remove it and every " +
      "reference to it.",
    "- Fix ONLY these findings plus what they force you to touch. Do not " +
      "refactor, rename, or improve anything else — new changes get " +
      "reviewed too, and unrelated ones fail the next round.",
    "- If you believe a finding is wrong, say so in one line with the " +
      "evidence that disproves it, and fix the rest. Do not silently skip " +
      "one.",
    "",
    "A fresh reviewer re-checks your work after this, with no memory of " +
      "this conversation. Leave the code in a state that passes on its own.",
  ];
  return lines.join("\n");
}

export function buildReviewPrompt(inputs: ReviewInputs): string {
  const lines: string[] = [
    "You are an INDEPENDENT code reviewer. You did not write this change " +
      "and have no memory of writing it — review it with the same " +
      "skepticism you would a stranger's pull request. Do NOT edit " +
      "anything; only inspect (read_file, the git tool's diff action, " +
      "retrieve_knowledge, search_symbols) and report.",
    "",
    "Files changed by the author agent:",
    ...inputs.changedFiles.slice(0, 30).map((f) => `- ${f}`),
  ];

  if (inputs.similar.length > 0) {
    lines.push(
      "",
      "Code elsewhere that closely resembles what changed, and that was " +
        "NOT changed (found by embedding similarity, so no import links " +
        "them — this is where duplicated logic hides):"
    );
    for (const hit of inputs.similar) {
      const where = hit.symbol ? ` (${hit.symbol})` : "";
      const rows =
        hit.startRow !== undefined ? ` lines ${hit.startRow}-${hit.endRow}` : "";
      lines.push(
        `- ${hit.path}${where}${rows} — ${Math.round(hit.score * 100)}% ` +
          `similar to ${hit.resembles}`
      );
    }
  }

  if (inputs.companionFiles.length > 0) {
    lines.push(
      "",
      "Companion files of what changed (same component/module — " +
        "template, class, styles, spec):",
      ...inputs.companionFiles.map((f) => `- ${f}`)
    );
  }

  lines.push(
    "",
    "Read the actual diff (git tool, action \"diff\") and the files above, " +
      "then check every point:",
    "1. DUPLICATED PATTERN — for each similar file above, decide whether " +
      "it has the same defect the change fixed. If it does, that is a " +
      "finding.",
    "2. REACHABLE STATES — for every branch, error message, or UI state " +
      "added, confirm the condition that triggers it can actually become " +
      "true. Check the companion files.",
    "3. CONTRACT MATCH — the values produced match what the consumer " +
      "expects (formats, units, separators, nullability), and the " +
      "callers/tests of anything touched still hold.",
    "4. SCOPE — no query or mutation that reaches outside its own unit " +
      "(document/window lookups, global state) where a scoped one works.",
    "5. LEFTOVERS — no unused imports, dead branches, stray syntax " +
      "(unbalanced braces/brackets/parens), or half-applied renames.",
    "",
    "Fail the review if ANY point has a real defect — do not pass code " +
      "with a known issue just because most points are clean.",
    "",
    "Reply with up to 6 short lines of findings (one per point, `OK` or " +
      "`ISSUE: <what>`), THEN end with exactly one final line and nothing " +
      "after it:",
    'VERDICT_JSON: {"verdict":"pass"|"fail","findings":["one line per ' +
      'real defect, empty array if pass"]}'
  );
  return lines.join("\n");
}
