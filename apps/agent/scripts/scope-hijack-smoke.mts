/**
 * Runtime smoke for the feature-match scope hijack.
 *
 * The reported failure, reproduced with the real projects involved: a
 * workspace holding three checkouts, a conversation working in
 * finops-crystal-lens, and a feature table whose entries span all three.
 * A plain-language turn matched features belonging to the OTHER two, the
 * lock was rewritten to `agenttest/my-app/` and `ai-doc-forge/` and
 * persisted, and every subsequent file the task needed was refused — the
 * model reporting the lock itself as the blocker.
 *
 * Uses a real temp workspace and a fake DB row store, since the live one
 * is better-sqlite3 built for the Electron ABI (plain tsx cannot open it).
 *
 *   cd apps/agent && pnpm exec tsx scripts/scope-hijack-smoke.mts
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SessionScopeStore,
  featureFocusFiles,
  type SessionScope,
} from "../src/workspace/scope/session-scope.js";
import type { Db } from "../src/storage/db.js";
import type { WorkspaceProfile } from "../src/workspace/profile/types.js";

const TARGET = "finops-crystal-lens";
const OTHER_A = "agenttest/my-app";
const OTHER_B = "ai-doc-forge";

let failed = false;
const check = (ok: boolean, message: string): void => {
  console.log(`  ${ok ? "ok" : "FAIL"}: ${message}`);
  if (!ok) failed = true;
};

/** The one table SessionScopeStore touches, as a Map. */
function fakeDb(): { db: Db; rows: Map<string, { roots: string; anchors: string }> } {
  const rows = new Map<string, { roots: string; anchors: string }>();
  const db = {
    prepare(sql: string) {
      if (sql.startsWith("SELECT")) {
        return { get: (id: string) => rows.get(id) };
      }
      if (sql.startsWith("DELETE")) {
        return { run: (id: string) => void rows.delete(id) };
      }
      return {
        run: (id: string, roots: string, anchors: string) =>
          void rows.set(id, { roots, anchors }),
      };
    },
  } as unknown as Db;
  return { db, rows };
}

const profile: WorkspaceProfile = {
  projects: [
    { path: TARGET },
    { path: OTHER_A },
    { path: OTHER_B },
  ],
} as unknown as WorkspaceProfile;

/** Files a workspace-wide feature match returned, spanning three projects. */
const CROSS_PROJECT_MATCH = [
  `${OTHER_A}/src/components/Report.tsx`,
  `${OTHER_B}/src/report/index.ts`,
];
const IN_PROJECT_MATCH = [
  `${TARGET}/src/contexts/BillingAccountContext.tsx`,
  `${TARGET}/src/pages/Chargeback.tsx`,
];

const root = await mkdtemp(path.join(tmpdir(), "atelier-scope-smoke-"));
try {
  for (const project of [TARGET, OTHER_A, OTHER_B]) {
    await mkdir(path.join(root, project, "src"), { recursive: true });
    await writeFile(path.join(root, project, "package.json"), "{}\n");
  }

  const { db, rows } = fakeDb();
  const store = new SessionScopeStore(db, root);
  const CHAT = "chat-1";

  // Project locking was removed on 2026-08-29: nothing below may produce a
  // root, and the protection against a foreign feature match now lives in
  // featureFocusFiles, keyed on the conversation's own anchors.
  console.log("\n[1] nothing locks — an explicit lock request is a no-op");
  const locked = store.lock(CHAT, [TARGET]);
  check(locked.roots.length === 0, "lock() returns no roots");
  check(
    JSON.parse(rows.get(CHAT)?.roots ?? "[]").length === 0,
    "and persists none"
  );
  await mkdir(path.join(root, TARGET, "src", "pages"), { recursive: true });
  await writeFile(path.join(root, TARGET, "src", "pages", "Chargeback.tsx"), "");
  const mentioned = store.resolve(CHAT, `look at @${TARGET}/src/pages/Chargeback.tsx`, profile);
  check(mentioned.roots.length === 0, "a folder/file mention does not lock either");
  check(
    mentioned.named.includes(`${TARGET}/src/pages/Chargeback.tsx`),
    "but the named file is the turn's subject"
  );
  check(
    JSON.parse(rows.get(CHAT)?.roots ?? "[]").length === 0,
    "the persisted row holds no roots"
  );

  console.log("\n[2] a conversation anchored in one project is not moved by a foreign match");
  const anchored = store.get(CHAT);
  check(
    anchored.anchors.some((anchor) => anchor.startsWith(TARGET)),
    `the conversation is anchored in ${TARGET}`
  );
  const focusable = featureFocusFiles(CROSS_PROJECT_MATCH, profile, anchored);
  check(
    focusable.length === 0,
    "a match spanning two foreign projects focuses nothing"
  );
  const unchanged = store.focusFiles(CHAT, focusable, profile);
  check(
    !unchanged.anchors.some((anchor) => anchor.startsWith(OTHER_A) || anchor.startsWith(OTHER_B)),
    "so no foreign file was recorded as an anchor"
  );

  console.log("\n[3] an in-project match anchors its files, without a lock");
  const focused = store.focusFiles(CHAT, IN_PROJECT_MATCH, profile);
  check(focused.roots.length === 0, "still no roots");
  check(
    focused.anchors.includes(`${TARGET}/src/pages/Chargeback.tsx`),
    "its files became anchors for the follow-up turns"
  );
  const FRESH = "chat-2";
  const guessed = store.focusFiles(FRESH, IN_PROJECT_MATCH, profile);
  check(guessed.roots.length === 0, "a fresh conversation gets no boundary");
  check(
    JSON.parse(rows.get(FRESH)?.roots ?? "[]").length === 0 &&
      store.get(FRESH).roots.length === 0,
    "and none is persisted or read back later"
  );
  // A row written by the old code still releases: its roots are ignored.
  rows.set("chat-legacy", {
    roots: JSON.stringify([OTHER_A, OTHER_B]),
    anchors: JSON.stringify([`${TARGET}/src/x.ts`]),
  });
  const legacy = store.get("chat-legacy");
  check(legacy.roots.length === 0, "a pre-existing locked row reads back unlocked");
  check(legacy.anchors.length === 1, "…with its anchors intact");

  console.log("\n[4] an ambiguous cross-project match focuses on nothing");
  const unlocked: SessionScope = {
    roots: [],
    anchors: [],
    allowed: [],
    named: [],
    source: "none",
    changed: false,
  };
  check(
    featureFocusFiles(CROSS_PROJECT_MATCH, profile, unlocked).length === 0,
    "two tied projects and no anchors to choose between them → no focus"
  );
  check(
    featureFocusFiles(IN_PROJECT_MATCH, profile, unlocked).length === 2,
    "a single-project match is still focusable"
  );
  const leaning: SessionScope = {
    ...unlocked,
    anchors: [`${OTHER_B}/src/report/index.ts`],
  };
  check(
    featureFocusFiles(CROSS_PROJECT_MATCH, profile, leaning).every((file) =>
      file.startsWith(OTHER_B)
    ),
    "an anchor in one of the tied projects breaks the tie for that project"
  );
  const lockedScope: SessionScope = { ...unlocked, roots: [TARGET] };
  check(
    featureFocusFiles(CROSS_PROJECT_MATCH, profile, lockedScope).length === 0,
    "a locked conversation drops every out-of-lock feature file"
  );
} catch (error) {
  failed = true;
  console.error("FAIL:", error);
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

console.log(failed ? "\nSMOKE FAILED" : "\nSMOKE OK");
process.exit(failed ? 1 : 0);
