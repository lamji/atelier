// Times the resolver's fast path against the real model, on the conflict
// shape it exists for. Run: npx tsx scripts/quick-resolve-live.mts [model]
import { resolveText } from "../src/git/conflict-quick-resolve.js";
import { runOneShot } from "../src/providers/one-shot.js";

const model = process.argv[2] ?? "claude-sonnet-5";
const file = [
  "import {",
  "<<<<<<< HEAD",
  "  resolveBillingSources,",
  "  resolveFocusGcpBillingSources,",
  "  toRawBillingSource,",
  "=======",
  "  resolveFocusGcpBillingSources,",
  ">>>>>>> 96e8155534a9667d",
  "  type BillingSource,",
  '} from "./billing";',
  "",
].join("\n");

const started = Date.now();
const outcome = await resolveText(
  file,
  { paths: [], ours: "fix/focus-format", theirs: "origin/SPDNX-Dev", kind: "merge" },
  (system, prompt) => runOneShot({ claudeFallback: model, system, prompt })
);
console.log(`${model}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log("content" in outcome ? outcome.content : `skipped: ${outcome.reason}`);
