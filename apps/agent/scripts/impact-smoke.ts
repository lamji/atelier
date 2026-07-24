/**
 * analyze_impact + community-clustering smoke against a warm index.
 *
 *   pnpm --filter @atelier/agent smoke:impact
 * (run smoke:knowledge first so the cache DB is populated)
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { openDb } from "../src/storage/db.js";
import { SymbolGraph } from "../src/knowledge/graph/symbol-graph.js";

const cacheDb = path.join(os.tmpdir(), "atelier-ksmoke-cache", "atelier.db");
if (!fs.existsSync(cacheDb)) {
  console.log("No warm cache DB — run `pnpm smoke:knowledge` first.");
  process.exit(1);
}

const db = openDb(path.join(os.tmpdir(), "atelier-ksmoke-cache"));
const graph = new SymbolGraph(db);

// analyze_impact core: dependentsOf + transitive ripple.
const target = "apps/agent/src/events/event-bus.ts";
const direct = graph.dependentsOf([target]);
console.log(`impact of ${target}:`);
console.log(`  direct dependents: ${direct.files.length}`);
console.log(`  affected symbols:  ${direct.symbols.length}`);
console.log(`  risk notes:        ${direct.lessons.length}`);

const ripple = new Set<string>();
let frontier = direct.files;
for (let d = 1; d < 3 && frontier.length > 0; d++) {
  const next = graph.dependentsOf(frontier);
  frontier = next.files.filter(
    (f) => f !== target && !direct.files.includes(f) && !ripple.has(f)
  );
  for (const f of frontier) ripple.add(f);
}
console.log(`  transitive (depth 3): ${ripple.size}`);

let fail = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) fail++;
};
check("event-bus has direct dependents", direct.files.length > 0);
check("dependentsOf excludes the target itself", !direct.files.includes(target));

db.close();
console.log(fail === 0 ? "\nimpact smoke pass" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
