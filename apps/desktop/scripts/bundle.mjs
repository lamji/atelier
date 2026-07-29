// Bundles the Electron main and preload entrypoints with esbuild.
// Usage: node scripts/bundle.mjs [--watch]
import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  external: ["electron"],
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
