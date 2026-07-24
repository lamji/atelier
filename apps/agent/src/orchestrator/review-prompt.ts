import type { CloneHit } from "../knowledge/impact/clone-scan.js";

export interface ReviewInputs {
  changedFiles: string[];
  similar: CloneHit[];
  companionFiles: string[];
}

/**
 * The self-review turn. Everything here targets a defect class that
 * compilers, linters and tests cannot see, and that human PR review
 * keeps catching:
 *
 *  - the same pattern fixed in one file and left in its twin (the vector
 *    sweep supplies the twins, since no import edge connects them);
 *  - UI/branch states that can never occur because the condition that
 *    would produce them does not exist (companion files supply the other
 *    half of the component);
 *  - global reach — document/window queries that escape the component.
 *
 * The model has tools here, so it fixes what it finds rather than
 * reporting it.
 */
export function buildReviewPrompt(inputs: ReviewInputs): string {
  const lines: string[] = [
    "SELF-REVIEW of the changes you just made. Verify them against the " +
      "codebase, fix what is wrong, and do not start new work.",
    "",
    "Files you changed:",
    ...inputs.changedFiles.slice(0, 30).map((f) => `- ${f}`),
  ];

  if (inputs.similar.length > 0) {
    lines.push(
      "",
      "Code elsewhere that closely resembles what you changed, and that " +
        "you did NOT change (found by embedding similarity, so no import " +
        "links them — this is where duplicated logic hides):"
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
      "Companion files of what you changed (same component/module — " +
        "template, class, styles, spec):",
      ...inputs.companionFiles.map((f) => `- ${f}`)
    );
  }

  lines.push(
    "",
    "Check every point, reading the files listed above (use `git diff` " +
      "through run_terminal if you need the exact edits):",
    "1. DUPLICATED PATTERN — for each similar file above, open it and " +
      "decide whether it has the same defect you just fixed. If it does, " +
      "fix it the same way. If it does not, say why in one line.",
    "2. REACHABLE STATES — for every branch, error message, or UI state " +
      "you added, confirm the condition that triggers it can actually " +
      "become true (a template error that needs a validator the class " +
      "does not declare is dead code). Check the companion files.",
    "3. CONTRACT MATCH — confirm the values you produce match what the " +
      "consumer expects (formats, units, separators, nullability), and " +
      "that the callers/tests of anything you touched still hold.",
    "4. SCOPE — no query or mutation that reaches outside its own unit " +
      "(document/window lookups, global state) where a scoped one works.",
    "5. LEFTOVERS — no unused imports, dead branches, or half-applied " +
      "renames from your edit.",
    "",
    "Fix what you find with the tools. Then reply with at most 6 lines: " +
      "one per point, each `OK` with a short reason or `FIXED <file>: " +
      "<what>`. If a similar file needed the same fix and you applied it, " +
      "say so explicitly."
  );
  return lines.join("\n");
}
