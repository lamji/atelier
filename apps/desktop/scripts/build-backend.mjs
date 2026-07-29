// Stages the backend for the packaged desktop app into build/backend/:
//   web/    built SPA (served by the supervisor's WebHost)
//   agent/  esbuild bundles + native runtime deps installed for the
//           ELECTRON ABI (the supervisor/agents run via ELECTRON_RUN_AS_NODE)
//
// Mirrors apps/cli/src/build.ts staging (kept byte-identical there for the
// CLI flow); the only difference is the install target ABI and out dir.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(desktopRoot, "..", "..");
const outRoot = path.join(desktopRoot, "build", "backend");
const webOut = path.join(outRoot, "web");
const agentOut = path.join(outRoot, "agent");

const require = createRequire(import.meta.url);
const electronVersion = require("electron/package.json").version;
const electronBinary = require("electron");

const isWindows = process.platform === "win32";

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: isWindows,
    ...opts,
  });
  if (result.status !== 0) {
    console.error(`[build-backend] ${cmd} ${args.join(" ")} failed`);
    process.exit(result.status ?? 1);
  }
}

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

// 1. Web UI — token never baked (ATELIER_PACKAGE=1 blanks vite defines).
console.log("[build-backend] building web UI (vite)");
run("pnpm", ["--filter", "@atelier/web", "build"], {
  cwd: repoRoot,
  env: { ...process.env, ATELIER_PACKAGE: "1" },
});
copyDir(path.join(repoRoot, "apps", "web", "dist"), webOut);

// 2. Agent bundles — identical esbuild options to apps/cli/src/build.ts.
console.log("[build-backend] bundling agent (esbuild)");
fs.mkdirSync(agentOut, { recursive: true });
const agentPkg = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "apps", "agent", "package.json"), "utf8"),
);
const allDeps = Object.keys(agentPkg.dependencies ?? {});
const external = allDeps.filter((d) => !d.startsWith("@atelier/"));

const cjsShim = {
  js: "import{createRequire as ___cr}from'module';const require=___cr(import.meta.url);",
};
const shared = {
  bundle: true,
  minify: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external,
  banner: cjsShim,
  logLevel: "warning",
};
const agentSrc = path.join(repoRoot, "apps", "agent", "src");
await esbuild({
  ...shared,
  entryPoints: [path.join(agentSrc, "main.ts")],
  outfile: path.join(agentOut, "main.mjs"),
});
await esbuild({
  ...shared,
  entryPoints: [path.join(agentSrc, "knowledge", "parsing", "parse-worker.ts")],
  outfile: path.join(agentOut, "parse-worker.mjs"),
});
await esbuild({
  ...shared,
  entryPoints: [path.join(agentSrc, "supervisor", "supervisor-main.ts")],
  outfile: path.join(agentOut, "supervisor-main.mjs"),
});
fs.copyFileSync(
  path.join(agentSrc, "storage", "schema.sql"),
  path.join(agentOut, "schema.sql"),
);

// 3. Install runtime deps normally, then retarget only the natives that
//    are NOT N-API at the Electron ABI. N-API packages (sharp,
//    onnxruntime-node, @lydell/node-pty prebuilds) are ABI-stable and a
//    global npm_config_runtime=electron actually breaks sharp's installer.
console.log("[build-backend] installing agent runtime deps");
const runtimePkg = {
  name: "atelier-agent-runtime",
  version: "0.1.0",
  private: true,
  type: "module",
  dependencies: Object.fromEntries(
    external.map((d) => [d, agentPkg.dependencies[d]]),
  ),
};
fs.writeFileSync(
  path.join(agentOut, "package.json"),
  JSON.stringify(runtimePkg, null, 2),
);
fs.writeFileSync(path.join(agentOut, ".npmrc"), "node-linker=hoisted\n");
run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: agentOut,
});

// better-sqlite3 links against V8 directly (not N-API), so fetch its
// Electron prebuild for the exact packaged Electron version.
console.log(
  `[build-backend] retargeting better-sqlite3 to electron ${electronVersion}`,
);
run("npm", ["run", "install"], {
  cwd: path.join(agentOut, "node_modules", "better-sqlite3"),
  env: {
    ...process.env,
    npm_config_runtime: "electron",
    npm_config_target: electronVersion,
    npm_config_disturl: "https://electronjs.org/headers",
  },
});

// 4. ABI smoke: require the native modules under Electron's Node before
//    ever packing an installer.
console.log("[build-backend] ABI smoke test (ELECTRON_RUN_AS_NODE)");
run(
  String(electronBinary),
  [
    "-e",
    "require('better-sqlite3');require('@lydell/node-pty');" +
      "console.log('native modules OK under Electron ABI')",
  ],
  {
    cwd: agentOut,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    shell: false,
  },
);

console.log(`[build-backend] staged backend at ${outRoot}`);
