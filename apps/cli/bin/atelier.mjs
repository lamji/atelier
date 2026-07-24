#!/usr/bin/env node
// Dev launcher: runs the TypeScript CLI via tsx. The globally-installed
// `atelier` command uses the bundled build produced by `atelier install`.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "src", "index.ts");
const result = spawnSync(
  "npx",
  ["tsx", entry, ...process.argv.slice(2)],
  { stdio: "inherit", shell: process.platform === "win32" }
);
process.exit(result.status ?? 0);
