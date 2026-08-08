// Bundles the Electron main and preload entrypoints with esbuild.
// Usage: node scripts/bundle.mjs [--watch]
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  // supabase-js and ws are bundled in (pure JS; the packaged app ships no
  // node_modules). ws's optional native accelerators are marked external —
  // its require() calls for them are try/catch-guarded at runtime.
  external: ["electron", "bufferutil", "utf-8-validate"],
  define: {
    "process.env.ATELIER_APP_VERSION": JSON.stringify(pkg.version),
  },
  logLevel: "info",
  outdir: path.join(root, "dist"),
  outExtension: { ".js": ".cjs" },
};

const options = {
  ...common,
  entryPoints: {
    main: path.join(root, "src", "main", "main.ts"),
    preload: path.join(root, "src", "preload", "preload.ts"),
  },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[desktop] esbuild watching main + preload");
} else {
  await esbuild.build(options);
}
