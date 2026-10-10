import assert from "node:assert/strict";
import { buildExecuteContext, compactExecuteContext } from "./pipeline-executor.js";

/** Roughly one token per four characters, which is what approxTokens does. */
function filler(tokens: number): string {
  return "word ".repeat(tokens);
}

const INLINED = ["src/lib/contractsApi.ts", "src/hooks/useContracts.ts"];

/**
 * The failure this locks down was watched in the telemetry rail:
 *
 *   previously gathered 2 · knowledge context 1.1k · feature wiki 756 …
 *
 * 1447 tokens of carried investigation packed down to TWO, because the
 * block sat second-from-last in the priority order. The turn was then told
 * the findings were above, the repeat guard was seeded as though they were,
 * and the turn re-investigated into a wall.
 */
async function main(): Promise<void> {
  // A realistic follow-up turn: everything present, budget over-subscribed.
  const sections = [
    { name: "answer-only rules", text: filler(371) },
    { name: "session memory", text: filler(322) },
    { name: "feature wiki", text: filler(756) },
    { name: "previously gathered", text: filler(1447) },
    { name: "attachments", text: filler(116) },
    { name: "knowledge context", text: filler(1100) },
  ];

  const built = buildExecuteContext({ sections, inlinedPaths: INLINED });
  const find = (name: string) =>
    built.sections.find((section) => section.name === name)?.text ?? "";

  assert.ok(
    find("previously gathered").length > 0,
    "the carried investigation must survive packing"
  );
  assert.ok(
    approx(find("previously gathered")) > 400,
    "and survive usefully, not as a clipped stub"
  );
  assert.equal(
    built.carriedInvestigation,
    true,
    "so the turn counts as already investigated"
  );

  const rules = find("investigation rules");
  assert.ok(rules.length > 0, "the rules always ship");
  assert.match(rules, /DO NOT RE-INVESTIGATE/);
  assert.match(rules, /contractsApi\.ts/, "and name the files it can see");

  // The rules are written from what SURVIVED, so a turn with nothing
  // carried is told to investigate rather than told to reuse nothing.
  const bare = buildExecuteContext({
    sections: [{ name: "knowledge context", text: filler(1100) }],
    inlinedPaths: [],
  });
  assert.equal(bare.carriedInvestigation, false);
  assert.match(
    bare.sections.find((s) => s.name === "investigation rules")?.text ?? "",
    /INVESTIGATE ONCE/,
    "an uninvestigated turn gets the first-turn rules"
  );

  // A turn whose gathered block IS clipped away must not be told it has one.
  const starved = buildExecuteContext({
    sections: [
      { name: "answer-only rules", text: filler(2600) },
      { name: "previously gathered", text: filler(1447) },
    ],
    inlinedPaths: INLINED,
  });
  const starvedRules =
    starved.sections.find((s) => s.name === "investigation rules")?.text ?? "";
  if (!starved.carriedInvestigation) {
    assert.match(
      starvedRules,
      /INVESTIGATE ONCE/,
      "no carried findings means no claim that there are any"
    );
    assert.doesNotMatch(
      starvedRules,
      /contractsApi\.ts/,
      "and no claim to hold files it cannot see"
    );
  }

  // The pinned-feature workflow: /context builds the map, and every later
  // turn anchors to it instead of rediscovering the feature.
  const anchored = buildExecuteContext({
    sections: [
      ...sections,
      { name: "session feature", text: filler(300) },
    ],
    inlinedPaths: INLINED,
    pinnedFeature: "contract creation",
  });
  const anchoredFind = (name: string) =>
    anchored.sections.find((section) => section.name === name)?.text ?? "";
  assert.ok(
    anchoredFind("session feature").length > 0,
    "the pinned map must never be the block that gets dropped"
  );
  assert.match(anchoredFind("investigation rules"), /ANCHORED TO THE PINNED/);
  assert.match(anchoredFind("investigation rules"), /contract creation/);
  assert.match(anchoredFind("investigation rules"), /context_update/);
  assert.equal(anchored.carriedInvestigation, true);

  // A pin whose map did NOT survive is not claimed as an anchor.
  const unshipped = buildExecuteContext({
    sections: [{ name: "answer-only rules", text: filler(3900) }],
    inlinedPaths: [],
    pinnedFeature: "contract creation",
  });
  assert.doesNotMatch(
    unshipped.sections.find((s) => s.name === "investigation rules")?.text ?? "",
    /ANCHORED TO THE PINNED/,
    "no map shipped, no anchor claimed"
  );

  // Every evidence block a real follow-up turn carries survives together:
  // that is what the raised budget buys, and the regression to watch for.
  for (const name of [
    "previously gathered",
    "feature wiki",
    "session memory",
    "knowledge context",
    "attachments",
  ]) {
    assert.ok(find(name).length > 0, `${name} must not be zeroed`);
  }

  // A correction turn: the user stopped the last attempt or says it was
  // wrong. The carried blocks still ship, but the rule no longer calls
  // them the answer — it points at what the user named and lets the turn
  // read the files earlier searches located.
  const corrected = buildExecuteContext({
    sections,
    inlinedPaths: INLINED,
    stance: "correct",
    named: {
      paths: ["src/i18n/translations.ts"],
      literals: ["No budgets configured yet"],
    },
  });
  const correctedRules =
    corrected.sections.find((s) => s.name === "investigation rules")?.text ?? "";
  assert.match(correctedRules, /RE-ANCHOR BEFORE YOU ACT/);
  assert.match(correctedRules, /translations\.ts/);
  assert.match(correctedRules, /No budgets configured yet/);
  assert.doesNotMatch(correctedRules, /Treat them as the answer/);
  assert.doesNotMatch(correctedRules, /Do not read these again/);
  assert.match(correctedRules, /VERIFICATION SCALES WITH THE CHANGE/);
  assert.equal(
    corrected.carriedInvestigation,
    true,
    "the evidence still rides; only the rule about it changes"
  );
  assert.match(rules, /VERIFICATION SCALES WITH THE CHANGE/, "every variant");

  // The reserve is real: the rules never come out of the evidence budget.
  const packedOnly = compactExecuteContext(sections);
  assert.ok(
    approx(packedOnly.map((s) => s.text).join("")) <= 4200,
    "the plain packer still respects the default budget"
  );
}

function approx(text: string): number {
  return Math.ceil(text.length / 4);
}

void main();
