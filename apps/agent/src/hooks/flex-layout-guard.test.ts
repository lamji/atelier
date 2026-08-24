import assert from "node:assert/strict";
import {
  FAST_RULES,
  readIntent,
} from "../orchestrator/pipeline-executor.js";
import { ATELIER_EXECUTOR_CONTRACT } from "../providers/executor-contract.js";
import { FlexLayoutGuard } from "./flex-layout-guard.js";

function main(): void {
  assert.equal(
    readIntent("Can you put the login component in the middle of the screen?").kind,
    "work",
    "a polite UI change request is actionable"
  );
  assert.equal(
    readIntent("Could the login component be centered?").kind,
    "work",
    "a passive polite change request is actionable"
  );
  assert.equal(
    readIntent("Why is the login component off-center?").kind,
    "question",
    "an information request stays read-only"
  );
  assert.equal(
    readIntent("Can you explain the login layout?").kind,
    "question",
    "a polite explanation request stays read-only"
  );
  assert.match(ATELIER_EXECUTOR_CONTRACT, /complete source of task instructions/);
  assert.match(ATELIER_EXECUTOR_CONTRACT, /finish the implementation/);
  assert.match(ATELIER_EXECUTOR_CONTRACT, /do not stop at analysis/);
  assert.match(ATELIER_EXECUTOR_CONTRACT, /EVIDENCE BOUNDARY/);
  assert.match(
    ATELIER_EXECUTOR_CONTRACT,
    /feature-map membership.*does not prove what an asset/
  );
  assert.match(
    ATELIER_EXECUTOR_CONTRACT,
    /inspect the exact source or asset with the available read\/image tool/
  );
  assert.match(
    ATELIER_EXECUTOR_CONTRACT,
    /identity is unknown.*do not invent the missing fact/
  );
  assert.match(ATELIER_EXECUTOR_CONTRACT, /plausible partial edit/);
  assert.match(FAST_RULES, /FLEX-FIRST UI LAYOUT/);
  assert.match(FAST_RULES, /display: flex/);

  const guard = new FlexLayoutGuard();
  assert.deepEqual(
    guard.check(
      "src/Login.css",
      ".screen { display: flex; align-items: center; justify-content: center; }"
    ),
    { ok: true },
    "CSS flex centering passes"
  );
  assert.deepEqual(
    guard.check(
      "src/Login.tsx",
      '<main className="flex min-h-screen items-center justify-center"><Login /></main>'
    ),
    { ok: true },
    "utility-class flex centering passes"
  );
  assert.equal(
    guard.check(
      "src/Login.css",
      ".screen { display: grid; place-items: center; }"
    ).ok,
    false,
    "CSS grid centering is blocked"
  );
  assert.equal(
    guard.check(
      "src/Login.css",
      ".screen { align-items: center; justify-content: center; }"
    ).ok,
    false,
    "CSS alignment without a flex container is blocked"
  );
  assert.equal(
    guard.check(
      "src/Login.tsx",
      '<main className="grid min-h-screen place-items-center"><Login /></main>'
    ).ok,
    false,
    "utility-class grid centering is blocked"
  );
  assert.equal(
    guard.check(
      "src/Login.tsx",
      '<main className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"><Login /></main>'
    ).ok,
    false,
    "absolute transform centering is blocked"
  );
  assert.equal(
    guard.check(
      "src/Login.tsx",
      '<main style={{ display: "grid", placeItems: "center" }}><Login /></main>'
    ).ok,
    false,
    "inline grid centering is blocked"
  );
  assert.deepEqual(
    guard.check(
      "src/Login.tsx",
      '<main style={{ display: "flex", alignItems: "center", justifyContent: "center" }}><Login /></main>'
    ),
    { ok: true },
    "inline flex centering passes"
  );
  const legacy = ".screen { display: grid; place-items: center; color: red; }";
  assert.deepEqual(
    guard.check(
      "src/Login.css",
      ".screen { display: grid; place-items: center; color: blue; }",
      legacy
    ),
    { ok: true },
    "an unrelated edit does not strand a legacy non-flex layout"
  );
  assert.deepEqual(
    guard.check(
      "src/state.ts",
      'const layout = { display: "grid", placeItems: "center" };'
    ),
    { ok: true },
    "non-UI source is outside the layout hook"
  );
}

main();
