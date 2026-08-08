/**
 * Regression: three folders mentioned in one prompt, only two of which the
 * workspace profile recognises as projects. All three must end up inside
 * the lock — the unrecognised one used to fall outside a lock built by its
 * own siblings, and the agent then refused to read it.
 *
 * Run: tsx scripts/scope-mention-smoke.ts <monorepoRoot>
 */
import path from "node:path";
import fs from "node:fs";
import { detectWorkspaceProfile } from "../src/workspace/profile/index.js";
import { SessionScopeStore, inScope } from "../src/workspace/scope/index.js";
import type { Db } from "../src/storage/db.js";

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ".";
const ROOT =
  process.argv[2] ?? path.join(HOME, "Documents", "RP_Docs", "woi");

/**
 * The two statements the scope store runs, backed by a Map. The native
 * sqlite binding in this checkout is built for the Electron ABI, so a
 * script run under plain node cannot open a real database.
 */
function memoryDb(): Db {
  const rows = new Map<string, { roots: string; anchors: string }>();
  return {
    prepare(sql: string) {
      return {
        get: (id: string) => (sql.includes("SELECT") ? rows.get(id) : undefined),
        run: (id: string, roots: string, anchors: string) => {
          if (sql.includes("INSERT")) rows.set(id, { roots, anchors });
          else rows.delete(id);
        },
      };
    },
  } as unknown as Db;
}

async function main(): Promise<void> {
  if (!fs.existsSync(ROOT)) {
    console.log(`skipped — no workspace at ${ROOT}`);
    return;
  }
  const wanted = ["apps/eats", "apps/backend", "apps/eats-pos"].filter((dir) =>
    fs.existsSync(path.join(ROOT, dir))
  );
  if (wanted.length < 2) {
    console.log(`skipped — needs at least two of apps/eats|backend|eats-pos`);
    return;
  }

  const profile = await detectWorkspaceProfile(ROOT);
  console.log(
    `profile: ${profile.kind} · projects: ` +
      profile.projects.map((p) => p.path).join(", ")
  );

  const store = new SessionScopeStore(memoryDb(), ROOT);
  const prompt =
    `understand how open tab works in @${wanted[0]}/ project this ` +
    `connected in @${wanted[1]}/ and @${wanted[2] ?? wanted[1]}/ tell me ` +
    "the user story";
  const scope = store.resolve("conv-mentions", prompt, profile);
  console.log(`locked: ${scope.roots.join(", ")}`);

  let failures = 0;
  for (const dir of wanted) {
    const covered = inScope(scope, `${dir}/src/x.ts`);
    if (!covered) failures += 1;
    console.log(`${covered ? "  ok " : "FAIL "} ${dir} readable under lock`);
  }
  console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILED`);
  if (failures > 0) process.exitCode = 1;
}

void main();
