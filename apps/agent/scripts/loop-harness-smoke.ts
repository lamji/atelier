/**
 * Proves the two fixes for a Claude task that ended with its gate open:
 *
 *  1. The scope guard no longer strands a task on a file outside the lock
 *     that plainly is the one it needs — an existing path with no same-named
 *     twin under the locked roots passes (and is reported); a twin, or a
 *     create outside the lock, is still refused.
 *  2. The loop harness: stall limits come from the environment (0 = never
 *     stop), the round prompt carries state + blockers, the BLOCKED: exit is
 *     recognised, and the blocker ledger dedupes.
 *
 * Pure and disk-local (a temp workspace); no DB, so plain tsx is enough.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ScopeGuard, fileNamedUnder } from "../src/tools/scope-guard.js";
import {
  BlockerLedger,
  harnessPrompt,
  loopHarnessLimits,
  reportsHardBlocker,
  reportsNoChangeNeeded,
} from "../src/orchestrator/loop-harness.js";
import {
  canRunNudge,
  completionGatePrompt,
  completionStopHookDecision,
  looksInformational,
  StreamStallWatch,
} from "../src/orchestrator/pipeline-executor.js";
import { streamStallLimits } from "../src/orchestrator/loop-harness.js";

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`${ok ? "ok" : "FAIL"} ${label}`);
  if (!ok) failures += 1;
}

function scopeGuard(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-guard-"));
  for (const rel of ["a/x.ts", "b/x.ts", "b/only.ts", "b/node_modules/pkg/only.ts"]) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), "//");
  }
  const ignore = {
    ignoresAbsolute: (abs: string) => abs.includes("node_modules"),
  };
  const escapes: string[] = [];
  const guard = new ScopeGuard({
    workspaceRoot: root,
    twinExists: (roots, basename) =>
      roots.some((r) => fileNamedUnder(path.join(root, r), basename, ignore)),
    onEscape: (_task, p, tool) => escapes.push(`${tool}:${p}`),
  });
  const scope = {
    roots: ["a"],
    anchors: [],
    allowed: [],
    named: [],
    source: "inherited" as const,
    changed: false,
  };
  guard.bind("t1", scope);

  const refused = (fn: () => unknown): string => {
    try {
      fn();
      return "";
    } catch (error) {
      return String(error);
    }
  };
  const twin = refused(() => guard.check("read_file", { path: "b/x.ts" }, "t1"));
  check(
    twin.includes("also exists inside the lock"),
    `same-named twin outside the lock is refused: ${twin.slice(0, 60)}`
  );
  check(
    refused(() => guard.check("read_file", { path: "b/only.ts" }, "t1")) === "",
    "an existing file with no twin passes"
  );
  check(escapes.length === 1 && escapes[0] === "read_file:b/only.ts", "escape reported once");
  check(
    refused(() => guard.check("replace_code", { path: "b/only.ts" }, "t1")) === "",
    "the same path passes again for an edit"
  );
  check(escapes.length === 1, "a repeat is not reported again");
  const create = refused(() =>
    guard.check("write_file", { path: "b/new.ts", content: "" }, "t1")
  );
  check(
    create.includes("does not exist in the workspace"),
    "creating outside the lock is still refused"
  );
  check(
    refused(() =>
      guard.check("read_many_files", { files: [{ path: "b/x.ts" }] }, "t1")
    ).includes("outside this session's scope"),
    "batched reads are guarded the same way"
  );
  check(
    refused(() => guard.check("read_file", { path: "../etc/passwd" }, "t1")) !== "",
    "escaping the workspace is refused"
  );
  check(
    !fileNamedUnder(path.join(root, "b"), "nope.ts", ignore) &&
      fileNamedUnder(path.join(root, "b"), "only.ts", ignore),
    "fileNamedUnder walks the tree, skipping ignored folders"
  );
  guard.release("t1");
  fs.rmSync(root, { recursive: true, force: true });
}

function harness(): void {
  const defaults = loopHarnessLimits({});
  check(defaults.gateStallLimit === 6 && defaults.continuationStallLimit === 3, "default stall limits");
  const unlimited = loopHarnessLimits({
    ATELIER_GATE_STALL_LIMIT: "0",
    ATELIER_CONTINUATION_STALL_LIMIT: "0",
  });
  check(
    unlimited.gateStallLimit === Infinity && unlimited.continuationStallLimit === Infinity,
    "zero means loop until done"
  );
  check(loopHarnessLimits({ ATELIER_GATE_STALL_LIMIT: "12" }).gateStallLimit === 12, "env raises the limit");
  check(loopHarnessLimits({ ATELIER_GATE_STALL_LIMIT: "junk" }).gateStallLimit === 6, "junk falls back");
  check(
    canRunNudge({ nudges: 1, gateNudges: 5, turnLimitContinuations: 3, gateRetry: true, aborted: false, gateStallLimit: 6 }) &&
      !canRunNudge({ nudges: 1, gateNudges: 6, turnLimitContinuations: 3, gateRetry: true, aborted: false, gateStallLimit: 6 }) &&
      canRunNudge({ nudges: 1, gateNudges: 999, turnLimitContinuations: 50, gateRetry: true, aborted: false, gateStallLimit: Infinity }),
    "gate retries are bounded only by consecutive stalls"
  );

  const ledger = new BlockerLedger();
  ledger.note("tool read_file", '"x" is outside this session\'s scope. locked to a/');
  ledger.note("tool read_file", '"x" is outside this session\'s scope. locked to a/');
  ledger.note("hook Git flow", "commit needs the wizard");
  const drained = ledger.drain();
  check(
    drained.length === 2 && drained[0]!.endsWith("(×2)") && ledger.drain().length === 0,
    "blocker ledger dedupes, counts, and resets"
  );

  const prompt = harnessPrompt({
    outstanding: "The completion gate found outstanding work.\n- [pending] Read Cud3Page",
    changedFiles: ["a/x.ts"],
    stepsDone: 1,
    stepsTotal: 3,
    attempt: 2,
    stalled: 1,
    blockers: drained,
  });
  check(
    prompt.includes("- [pending] Read Cud3Page") &&
      prompt.includes("STATE SO FAR (round 2): 1/3 plan step(s) done · 1 file(s) changed (a/x.ts)") &&
      prompt.includes("BLOCKERS HIT IN THE LAST ROUND") &&
      prompt.includes("outside this session's scope") &&
      prompt.includes("previous 1 round(s) changed nothing") &&
      prompt.includes("`BLOCKED:`"),
    "harness prompt carries outstanding items, state, blockers, and the exit"
  );
  check(
    reportsHardBlocker("did the rest.\n\nBLOCKED: finops-crystal-lens is outside the lock") &&
      reportsHardBlocker("**BLOCKED:** scope") &&
      !reportsHardBlocker("the request was blocked earlier but is now done"),
    "BLOCKED: exit is recognised only as a line"
  );
}

/**
 * The gate's declared exits. Both were unreachable: the Stop hook erased
 * the report carrying them, so a turn with nothing left to do could only
 * end by spending its stall budget and warning the user it might be
 * unfinished.
 */
function honestExits(): void {
  const open = completionGatePrompt([], false, true, false);
  check(
    open.includes("NO CHANGE NEEDED:"),
    "the no-edit gate item names the exit that closes it"
  );
  check(
    reportsNoChangeNeeded(
      "read it all.\n\nNO CHANGE NEEDED: the user pasted a curl result"
    ) &&
      reportsNoChangeNeeded("**NO CHANGE NEEDED:** already correct") &&
      !reportsNoChangeNeeded("no change needed to the schema, but the route needs one"),
    "NO CHANGE NEEDED: is recognised only as a line"
  );
  check(
    completionStopHookDecision(open, false).decision === "block",
    "an ordinary report is still refused while the gate is open"
  );
  check(
    completionStopHookDecision(open, false, "NO CHANGE NEEDED: nothing to do").decision ===
      undefined &&
      completionStopHookDecision(open, false, "BLOCKED: needs your approval").decision ===
        undefined,
    "a declared exit ends the turn instead of erasing the report"
  );
  check(
    completionStopHookDecision("", false).decision === undefined,
    "a closed gate accepts anything"
  );
}

/** Turns that only tell Atelier something must not owe it an edit. */
function informational(): void {
  const stated = [
    "i will prove you wrong curl --url https://dev.spndx.ai/api/v1/auth/login",
    "that was the dev environment",
    "fyi the refresh token already expired",
    "here's what the endpoint returns: {\"error\":\"Not Found\"}",
    "i just ran it and it returned 404",
  ];
  for (const prompt of stated) {
    check(looksInformational(prompt), `informational: ${prompt.slice(0, 40)}`);
  }
  const work = [
    "i just ran it and it 404s, fix the route",
    "that was the dev url — update the base path",
    "add a superadmin login route",
    "can you center the login?",
  ];
  for (const prompt of work) {
    check(!looksInformational(prompt), `still work: ${prompt.slice(0, 40)}`);
  }
}

/**
 * The silence watchdog. Nothing else on the stream path can see a stall:
 * every other bound needs a message to arrive.
 */
async function stallWatch(): Promise<void> {
  check(
    streamStallLimits({} as NodeJS.ProcessEnv).warnMs === 180_000 &&
      streamStallLimits({ ATELIER_STREAM_WARN_MS: "20" } as NodeJS.ProcessEnv)
        .warnMs === 20 &&
      streamStallLimits({ ATELIER_STREAM_ABORT_MS: "0" } as NodeJS.ProcessEnv)
        .abortMs === Infinity,
    "stall limits default, override, and switch off"
  );

  const said: string[] = [];
  let aborted = 0;
  const watch = new StreamStallWatch(
    (detail) => said.push(detail),
    () => {
      aborted += 1;
    },
    { warnMs: 20, abortMs: 40 }
  );
  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  // A chatty stream never trips it: each beat re-arms from now.
  for (let i = 0; i < 5; i += 1) {
    await wait(10);
    watch.beat();
  }
  check(said.length === 0 && aborted === 0, "a beating stream never trips");

  await wait(30);
  check(
    said.length === 1 && (said[0] ?? "").startsWith("no provider output for"),
    "silence past the warning is reported instead of shown as progress"
  );
  check(!watch.abandoned && aborted === 0, "a warning alone does not cut the turn");

  // Speaking again clears the warning rather than leaving it on screen.
  watch.beat();
  check(said[said.length - 1] === "working", "output after a warning clears it");

  await wait(70);
  check(
    watch.abandoned &&
      aborted === 1 &&
      watch.note().includes("stopped responding") &&
      (said[said.length - 1] ?? "").includes("abandoned"),
    "sustained silence aborts, and says so before the cancel path takes over"
  );
  watch.stop();
}

scopeGuard();
harness();
honestExits();
informational();
await stallWatch();
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("loop-harness smoke passed");
