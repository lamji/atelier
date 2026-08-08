import { isTrivialChat } from "../src/orchestrator/trivial-chat.js";

const CASES: Array<[string, boolean]> = [
  ["hi", true],
  ["thanks!", true],
  ["ok cool", true],
  ["nice one", true],
  ["good morning", true],
  ["so why i cant login? docker is running and etc", false],
  ["why you did not found it earlier?", false],
  ["fix the terminal search", false],
  ["build in 1.0.4", false],
  ["apps/web/src/App.tsx", false],
  ["run the tests", false],
  ["the other issue?", false],
];

let failed = 0;
for (const [prompt, want] of CASES) {
  const got = isTrivialChat(prompt, false);
  if (got !== want) {
    failed++;
    console.log(`MISMATCH ${JSON.stringify(prompt)} want=${want} got=${got}`);
  }
}
console.log(failed === 0 ? "all cases pass" : `${failed} mismatch(es)`);
