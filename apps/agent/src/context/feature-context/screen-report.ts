import type {
  EntryPointMatch,
  ImpactRadius,
} from "./feature-context-store.js";
import type { ScreenEvidence } from "./screen-commands.js";

const MAX_LISTED_FILES = 60;
const MAX_LISTED_SYMBOLS = 80;

/** What the command knew about the screen, so the answer is auditable. */
function evidenceLines(evidence: ScreenEvidence, hint: string): string[] {
  const lines: string[] = ["### Screen evidence", ""];
  lines.push(
    evidence.route
      ? `- Route: \`${evidence.route}\``
      : "- Route: none captured (no page preview rode with this send)"
  );
  if (evidence.routeTerms.length > 0) {
    lines.push(`- Route terms: ${evidence.routeTerms.join(", ")}`);
  }
  if (evidence.labels.length > 0) {
    lines.push(
      `- On-screen text: ${evidence.labels.slice(0, 8).join(" · ")}` +
        (evidence.labels.length > 8
          ? ` … (${evidence.labels.length - 8} more)`
          : "")
    );
  }
  if (hint) lines.push(`- Your hint: ${hint}`);
  return lines;
}

/**
 * The /entry_point answer.
 *
 * Ranked rather than singular, and it says so: a screen can legitimately
 * have more than one entry — a route, the page component it mounts, the
 * modal opened on top of it — and picking one silently would hide the
 * choice. The top match is called out because that is what /impact_radius
 * will walk from unless the user names another.
 */
export function renderEntryPointReport(input: {
  matches: EntryPointMatch[];
  evidence: ScreenEvidence;
  hint: string;
}): string {
  const [best, ...rest] = input.matches;
  const lines = [`## Entry point`, ""];
  if (!best) {
    lines.push(
      "No indexed symbol matched this screen.",
      "",
      ...evidenceLines(input.evidence, input.hint),
      "",
      input.evidence.hasPreview
        ? "The page preview was captured but nothing in the tree-sitter " +
          "index matched its route or its text. Try `/entry_point <name>` " +
          "with a word from the code, or wait for indexing to finish."
        : "No page preview rode with this send, so there was no route to " +
          "match on. Open the screen in Page preview, mark it, and send " +
          "`/entry_point` again — or pass a name: `/entry_point budgets`."
    );
    return lines.join("\n");
  }
  lines.push(
    `**\`${best.name}\`** — \`${best.path}:${best.startRow + 1}\` (${best.kind})`,
    ""
  );
  if (best.signature) lines.push("```", best.signature.trim(), "```", "");
  if (rest.length > 0) {
    lines.push("### Other candidates", "");
    for (const match of rest) {
      lines.push(
        `- \`${match.name}\` — \`${match.path}:${match.startRow + 1}\` (${match.kind})`
      );
    }
    lines.push("");
  }
  lines.push(...evidenceLines(input.evidence, input.hint), "");
  lines.push(
    "---",
    "",
    "Pinned to this conversation. Run `/impact_radius` to walk everything " +
      "connected to it end to end."
  );
  return lines.join("\n");
}

/**
 * The /impact_radius answer: every file and function reachable from the
 * entry points, in both directions.
 *
 * Grouped by file rather than listed flat, because the question behind the
 * command is "what do I have to touch, and what might I break" — and that
 * is answered per file. Roles are kept on each symbol so a caller (someone
 * who depends on this screen) reads differently from a callee (something
 * the screen depends on).
 */
export function renderImpactRadiusReport(input: {
  entries: EntryPointMatch[];
  radius: ImpactRadius;
  evidence: ScreenEvidence;
}): string {
  const { radius } = input;
  const lines = ["## Impact radius", ""];
  if (radius.symbols.length === 0) {
    return [
      ...lines,
      "Nothing is connected to the pinned entry point in the current index.",
      "",
      "That usually means indexing has not finished, or the entry point is " +
        "isolated (a leaf component nothing else calls).",
    ].join("\n");
  }

  lines.push(
    `From ${input.entries.length} entry point(s): ` +
      `**${radius.files.length} file(s)**, ` +
      `**${radius.symbols.length} function(s)/symbol(s)**, ` +
      `${radius.calls.length} call edge(s), ` +
      `${radius.imports.length} import edge(s).`,
    ""
  );

  lines.push("### Entry points", "");
  for (const entry of input.entries) {
    lines.push(
      `- \`${entry.name}\` — \`${entry.path}:${entry.startRow + 1}\``
    );
  }
  lines.push("");

  const byPath = new Map<string, typeof radius.symbols>();
  for (const symbol of radius.symbols) {
    const bucket = byPath.get(symbol.path) ?? [];
    bucket.push(symbol);
    byPath.set(symbol.path, bucket);
  }
  // Seed files first, then the widest — the order someone would read them.
  const ordered = [...byPath.entries()].sort(
    (a, b) =>
      seedRank(a[1], radius) - seedRank(b[1], radius) ||
      b[1].length - a[1].length ||
      a[0].localeCompare(b[0])
  );

  lines.push("### Connected files and functions", "");
  let listedSymbols = 0;
  for (const [path, symbols] of ordered.slice(0, MAX_LISTED_FILES)) {
    lines.push(`**\`${path}\`**`);
    for (const symbol of symbols) {
      if (listedSymbols >= MAX_LISTED_SYMBOLS) break;
      listedSymbols += 1;
      const role = radius.roles.get(symbol.id) ?? "connected";
      lines.push(
        `- \`${symbol.name}\` (${symbol.kind}, ${role}) — line ${symbol.startRow + 1}`
      );
    }
    lines.push("");
  }
  if (ordered.length > MAX_LISTED_FILES) {
    lines.push(
      `… ${ordered.length - MAX_LISTED_FILES} more file(s) in the radius, ` +
        "not listed."
    );
  }
  if (radius.symbols.length > listedSymbols) {
    lines.push(
      `… ${radius.symbols.length - listedSymbols} more symbol(s) not listed.`
    );
  }

  // Files pulled in by imports that hold none of the walked symbols are
  // still part of the blast radius, and are the ones most easily missed.
  const symbolFiles = new Set(radius.symbols.map((symbol) => symbol.path));
  const importOnly = radius.files
    .map((file) => file.path)
    .filter((path) => !symbolFiles.has(path));
  if (importOnly.length > 0) {
    lines.push(
      "",
      "### Reached by imports only",
      "",
      ...importOnly.slice(0, 20).map((path) => `- \`${path}\``),
      importOnly.length > 20
        ? `… ${importOnly.length - 20} more.`
        : ""
    );
  }
  lines.push(
    "",
    "---",
    "",
    ...evidenceLines(input.evidence, "")
  );
  return lines.filter((line) => line !== undefined).join("\n");
}

function seedRank(
  symbols: ImpactRadius["symbols"],
  radius: ImpactRadius
): number {
  return symbols.some((symbol) => radius.roles.get(symbol.id) === "seed")
    ? 0
    : 1;
}
