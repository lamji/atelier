/**
 * Reproduces the token-heavy page-preview request at the current maximum
 * payload sizes, then compares its model-input allocation with the historical
 * request that reported ~155.1k total / ~137.1k prompt tokens.
 *
 * The historical non-prompt allocation is held constant so this isolates the
 * reduction delivered by bounding the hidden preview prompt.
 *
 *   pnpm --filter @atelier/agent smoke:prompt-budget
 */
import assert from "node:assert/strict";
import { approxTokens, wrapHiddenContext } from "@atelier/shared";
import {
  buildLlmRequest,
  promptWithRelevantPreview,
} from "../src/orchestrator/llm-request.js";
import {
  compactExecuteContext,
  renderTaskTokenReport,
} from "../src/orchestrator/pipeline-executor.js";
import { BUDGETS } from "../src/context/types.js";

const HISTORICAL_TOTAL_TOKENS = 155_100;
const HISTORICAL_PROMPT_TOKENS = 137_100;
const HISTORICAL_NON_PROMPT_TOKENS =
  HISTORICAL_TOTAL_TOKENS - HISTORICAL_PROMPT_TOKENS;
const MIN_TOTAL_REDUCTION = 0.5;
const MIN_PROMPT_REDUCTION = 0.8;
const SCREENSHOT_MODEL_INPUT_TOKENS = 10_000;
const MAX_COMPACT_MODEL_INPUT_TOKENS = 6_000;
const MAX_DYNAMIC_CONTEXT_TOKENS = 3_000;

function fillToLength(seed: string, length: number): string {
  return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
}

function maximumCurrentPreviewContext(): string {
  const html = fillToLength(
    '<section class="login-card"><label>Email</label><input type="email"><button class="login-button">Log in</button></section>',
    12_000
  );
  const css = fillToLength(
    ".login-card{display:flex;align-items:center;justify-content:center;padding:16px}.login-button{color:#fff;background:#2563eb;border:0}",
    6_000
  );
  const interactive = Array.from({ length: 40 }, (_, index) =>
    [
      `#field-${index}`,
      "<button>",
      JSON.stringify(`Login action ${index}`),
      `(${index * 4},${index * 3} 120x36)`,
      "color=rgb(255,255,255)",
      "background=rgb(37,99,235)",
      "border=rgb(37,99,235)",
      "font=14px sans-serif",
      "display=flex",
      "visibility=visible",
    ].join(" ")
  ).join("\n");
  const consoleEntries = Array.from({ length: 20 }, (_, index) =>
    `[error] ${fillToLength(`preview failure ${index} `, 500)} (app.ts:${index + 1})`
  ).join("\n");

  // The tagged layout the renderer emits (apps/web/src/services/
  // preview-context.ts). The smoke used to carry an older `HTML:` / `CSS:`
  // layout, which is how the strip regex went stale unnoticed: the smoke
  // passed against a shape production had stopped sending.
  return [
    "CURRENT PAGE PREVIEW RUNTIME CONTEXT",
    "",
    "URL: http://localhost:5173/login",
    "",
    "Title: Login",
    "",
    "<interactive-elements>",
    interactive,
    "</interactive-elements>",
    "",
    "<console-diagnostics>",
    consoleEntries,
    "</console-diagnostics>",
    "",
    "<page-html>",
    html,
    "</page-html>",
    "",
    "<page-css>",
    css,
    "</page-css>",
  ].join("\n");
}

function originalRequestFixture(): string {
  const originalRequest = [
    "now, since you have access to a web preview. create a bridge to get the",
    "entire html of the current displayed page. i know it has the entire html",
    "and css. this means the ai should have knowledge or context about the",
    "current page displayed.",
    "- if user asks to update the color of the login button, the ai already",
    "  knows what button to look for without searching the codebase",
    "- same with a console error: if the ai sees it while displaying an app,",
    "  automatically fix it",
  ].join("\n");

  return [
    originalRequest,
    "",
    wrapHiddenContext(maximumCurrentPreviewContext()),
  ].join("\n");
}

function ordinaryPreviewRequestFixture(): string {
  return [
    "update the color of the login button and fix the console error shown",
    "in the current preview.",
    "",
    wrapHiddenContext(maximumCurrentPreviewContext()),
  ].join("\n");
}

function percent(reduction: number): string {
  return `${(reduction * 100).toFixed(1)}%`;
}

const ordinaryPrompt = promptWithRelevantPreview(
  ordinaryPreviewRequestFixture()
);
assert.doesNotMatch(ordinaryPrompt, /<page-html>/);
assert.doesNotMatch(ordinaryPrompt, /<page-css>/);
assert.match(ordinaryPrompt, /<interactive-elements>/);
assert.match(ordinaryPrompt, /<console-diagnostics>/);

const explicitMarkupPrompt = promptWithRelevantPreview(originalRequestFixture());
assert.match(explicitMarkupPrompt, /<page-html>/);
assert.match(explicitMarkupPrompt, /<page-css>/);

const sharedRequest = {
  purpose: "execute" as const,
  provider: "codex" as const,
  model: "prompt-budget-smoke",
  sections: [
    {
      name: "unchanged non-prompt context",
      text: "S".repeat(HISTORICAL_NON_PROMPT_TOKENS * 4),
    },
  ],
};
const current = buildLlmRequest({ ...sharedRequest, prompt: ordinaryPrompt });
const explicit = buildLlmRequest({
  ...sharedRequest,
  prompt: explicitMarkupPrompt,
});
assert.ok(
  current.promptTokens < explicit.promptTokens,
  "ordinary preview requests must omit the raw markup token cost"
);

assert.equal(
  current.systemTokens,
  HISTORICAL_NON_PROMPT_TOKENS,
  "comparison must hold the historical non-prompt allocation constant"
);

// Reproduce the allocation shown in the process rail: ~10k tokens after
// workspace/rules/scope plus session, wiki, gathered, attachment, and current
// knowledge blocks were all stacked into one request.
const railBaseSections = [
  { name: "workspace layout", text: fillToLength("W", 353 * 4) },
  { name: "rules", text: fillToLength("R", 1_700 * 4) },
  { name: "scope lock", text: fillToLength("S", 288 * 4) },
];
const railDynamicSections = [
  { name: "session memory", text: fillToLength("M", 900 * 4) },
  { name: "session feature", text: fillToLength("F", 522 * 4) },
  { name: "feature wiki", text: fillToLength("K", 1_700 * 4) },
  { name: "previously gathered", text: fillToLength("G", 3_400 * 4) },
  { name: "attachments", text: fillToLength("A", 116 * 4) },
  { name: "knowledge context", text: fillToLength("C", 1_100 * 4) },
];
const railPrompt =
  "reduce the context cost from gathering through the request sent to the model";
const uncappedRail = buildLlmRequest({
  purpose: "execute",
  provider: "codex",
  model: "prompt-budget-smoke",
  sections: [...railBaseSections, ...railDynamicSections],
  prompt: railPrompt,
});
const compactRailSections = compactExecuteContext(railDynamicSections);
const compactRail = buildLlmRequest({
  purpose: "execute",
  provider: "codex",
  model: "prompt-budget-smoke",
  sections: [...railBaseSections, ...compactRailSections],
  prompt: railPrompt,
});
const compactDynamicTokens = compactRailSections.reduce(
  (sum, section) => sum + approxTokens(section.text),
  0
);

assert.ok(
  uncappedRail.totalTokens >= SCREENSHOT_MODEL_INPUT_TOKENS,
  "fixture must reproduce the approximately 10k-token model input"
);
assert.ok(
  compactDynamicTokens <= MAX_DYNAMIC_CONTEXT_TOKENS,
  "dynamic execute context must honor its hard ceiling"
);
assert.ok(
  compactRail.totalTokens <= MAX_COMPACT_MODEL_INPUT_TOKENS,
  "ordinary execute requests must stay below the compact model-input ceiling"
);
assert.ok(
  compactRail.sections.some((section) => section.name === "knowledge context"),
  "current retrieved evidence must survive compaction"
);
assert.ok(
  compactRail.sections.some((section) => section.name === "feature wiki"),
  "the compact feature flow must survive compaction"
);
assert.ok(
  BUDGETS.edit!.totalTokens <= 1_400 &&
    BUDGETS.feature!.totalTokens <= 2_000,
  "gathering budgets must remain materially below their old ceilings"
);

const tokenReport = renderTaskTokenReport({
  turns: [
    {
      purpose: "execute",
      inputTokens: 1_200,
      cacheReadTokens: 300,
      cacheCreationTokens: 50,
      outputTokens: 200,
      totalTokens: 1_750,
    },
    {
      purpose: "review",
      inputTokens: 400,
      cacheReadTokens: 200,
      cacheCreationTokens: 20,
      outputTokens: 100,
      totalTokens: 720,
    },
  ],
  totalTokens: 2_470,
});
assert.equal(
  tokenReport,
  [
    "- Model turn 1 (execute): 1,750 total tokens " +
      "(input 1,200, cache read 300, cache write 50, output 200)",
    "- Model turn 2 (review): 720 total tokens " +
      "(input 400, cache read 200, cache write 20, output 100)",
    "- Final token total: 2,470 tokens",
  ].join("\n"),
  "the final report must list every model turn and the cumulative token total"
);

const totalReduction = 1 - current.totalTokens / HISTORICAL_TOTAL_TOKENS;
const promptReduction = 1 - current.promptTokens / HISTORICAL_PROMPT_TOKENS;

console.log(
  `historical: total ~${HISTORICAL_TOTAL_TOKENS.toLocaleString()} tok, ` +
    `prompt ~${HISTORICAL_PROMPT_TOKENS.toLocaleString()} tok`
);
console.log(
  `ordinary preview fixture: total ~${current.totalTokens.toLocaleString()} tok, ` +
    `prompt ~${current.promptTokens.toLocaleString()} tok, ` +
    `unchanged non-prompt ~${current.systemTokens.toLocaleString()} tok`
);
console.log(
  `explicit HTML/CSS request: total ~${explicit.totalTokens.toLocaleString()} tok, ` +
    `prompt ~${explicit.promptTokens.toLocaleString()} tok`
);
console.log(
  `reduction: total ${percent(totalReduction)}, prompt ${percent(promptReduction)}`
);
console.log(
  `process-rail fixture: ~${uncappedRail.totalTokens.toLocaleString()} → ` +
    `~${compactRail.totalTokens.toLocaleString()} model-input tokens ` +
    `(${percent(1 - compactRail.totalTokens / uncappedRail.totalTokens)} lower)`
);

assert.ok(
  totalReduction >= MIN_TOTAL_REDUCTION,
  `total-token reduction ${percent(totalReduction)} is below ` +
    `${percent(MIN_TOTAL_REDUCTION)}`
);
assert.ok(
  promptReduction >= MIN_PROMPT_REDUCTION,
  `prompt-token reduction ${percent(promptReduction)} is below ` +
    `${percent(MIN_PROMPT_REDUCTION)}`
);
console.log(
  "PASS preview markup is demand-loaded, execute context stays under 6k " +
    "tokens, and final reports include per-turn and cumulative token totals"
);
