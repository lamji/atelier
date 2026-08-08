// Bundles the agent's utilityProcess entry for the desktop app.
// Output: dist-electron/{utility-main.mjs, parse-worker.mjs, schema.sql}
// Externals stay in node_modules (native modules + heavyweight deps), so in
// dev the bundle resolves them from apps/agent/node_modules; the packaged
// app installs them into resources/agent (see desktop build-backend.mjs).
// Usage: node scripts/bundle-electron.mjs [--watch]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist-electron");
const watch = process.argv.includes("--watch");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const external = Object.keys(pkg.dependencies ?? {}).filter(
  (d) => !d.startsWith("@atelier/"),
);

const cjsShim = {
  js: "import{createRequire as ___cr}from'module';const require=___cr(import.meta.url);",
};

/** @type {import("esbuild").BuildOptions} */
const options = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  external,
  banner: cjsShim,
  logLevel: "info",
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  entryPoints: {
    "utility-main": path.join(root, "src", "utility-main.ts"),
    "parse-worker": path.join(root, "src", "knowledge", "parsing", "parse-worker.ts"),
    // Stdio MCP server Codex spawns; must sit beside utility-main.mjs.
    "codex-mcp": path.join(root, "src", "providers", "codex", "mcp-main.ts"),
  },
};

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(
  path.join(root, "src", "storage", "schema.sql"),
  path.join(outDir, "schema.sql"),
);

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[agent] esbuild watching utility-main + parse-worker");
} else {
  await esbuild.build(options);
}
