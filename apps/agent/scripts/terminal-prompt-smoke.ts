/**
 * Proves the preview launcher can tell "the dev server is asking me
 * something" from "the dev server is still starting".
 *
 * Real captures: create-react-app's port clash, Expo's, Next's, npx's
 * install confirmation, and Windows' batch-job question — against the build
 * chatter that must NOT raise a dialog nobody can answer.
 *
 *   pnpm --filter @atelier/agent smoke:terminal-prompt
 */
import {
  pendingTerminalPrompt,
  terminalAnswer,
} from "@atelier/shared";

let failures = 0;
function check(ok: boolean, label: string, extra = ""): void {
  console.log(`${ok ? "ok" : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures += 1;
}

const ESC = "";

const ASKING: Array<[string, string, string]> = [
  [
    "create-react-app port clash",
    "? Something is already running on port 3000.\n\nWould you like to run the app on another port instead? › (Y/n)",
    "Would you like to run the app on another port instead?",
  ],
  [
    "expo port clash",
    "Port 8081 is running this app in another window.\nUse port 8082 instead? (Y/n)",
    "Use port 8082 instead?",
  ],
  [
    "next port clash",
    "  ▲ Next.js 15.0.0\n? Port 3000 is in use. Use available port 3001 instead? [Y/n]",
    "Port 3000 is in use. Use available port 3001 instead?",
  ],
  [
    "npx install confirmation",
    "Need to install the following packages:\n  create-expo-app@3.0.0\nOk to proceed? (y)",
    "Ok to proceed?",
  ],
  [
    "windows batch job",
    "npm run start\nTerminate batch job (Y/N)?",
    "Terminate batch job",
  ],
  [
    "hint on its own line, question above",
    "The port is taken.\nRun on another port instead?\n› (Y/n)",
    "Run on another port instead?",
  ],
  [
    "coloured prompt",
    `${ESC}[36m?${ESC}[0m Use available port 3001 instead? ${ESC}[2m(Y/n)${ESC}[0m`,
    "Use available port 3001 instead?",
  ],
  [
    "redrawn spinner line before the prompt",
    "⠋ starting\r⠙ starting\r⠹ starting\nOverwrite the existing build? (y/N)",
    "Overwrite the existing build?",
  ],
];

for (const [label, output, question] of ASKING) {
  const found = pendingTerminalPrompt(output);
  check(found !== null, `asking: ${label}`);
  check(
    found?.question === question,
    `  question reads cleanly: ${label}`,
    found?.question
  );
}

const NOT_ASKING: Array<[string, string]> = [
  ["a server that started", "VITE v5.4.0 ready in 412 ms\n\n  ➜  Local: http://localhost:5173/"],
  ["compiler output", "webpack compiled successfully\nNo issues found."],
  [
    "a question already answered",
    "Would you like to run the app on another port instead? › (Y/n) y\nStarting the development server…",
  ],
  [
    "a question quoted mid-output",
    "note: some tools ask 'proceed? (y/n)' here\nCompiled successfully.\nLocal: http://localhost:3000",
  ],
  ["a bare question mark in prose", "Did you mean to import React?\nBuild finished."],
  ["nothing at all", ""],
  ["only whitespace", "\n\n   \n"],
];

for (const [label, output] of NOT_ASKING) {
  check(pendingTerminalPrompt(output) === null, `not asking: ${label}`);
}

check(terminalAnswer("yes") === "y\r", "yes submits y");
check(terminalAnswer("no") === "n\r", "no submits n");
check(
  terminalAnswer("default") === "\r",
  "the default answer is a bare newline, not an empty write"
);

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("terminal-prompt smoke passed");
