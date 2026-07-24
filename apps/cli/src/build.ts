import fs from "node:fs";
import path from "node:path";
import { build as esbuild } from "esbuild";
import { execa } from "execa";
import { installRoot, webDist } from "./paths.js";
import { step, ok, info } from "./ui.js";

/**
 * Native / asset-bearing packages that must stay real node_modules (they
 * resolve .node binaries or wasm/model assets via require.resolve at
 * runtime) — everything else is bundled into main.mjs.
 */
const EXTERNAL_NATIVE = [
  "better-sqlite3",
  "sqlite-vec",
  "@lydell/node-pty",
  "web-tree-sitter",
  "tree-sitter-wasms",
  "@huggingface/transformers",
  "@anthropic-ai/claude-agent-sdk",
];

export interface BuildResult {
  agentEntry: string;
  webDir: string;
}

/**
 * Builds a distributable Atelier into the install directory:
 *  1. Vite-builds the web UI (token injected at runtime, not baked).
 *  2. esbuild-bundles + minifies our agent source into main.mjs, keeping
 *     native/asset packages external.
 *  3. Installs just those external packages so their binaries resolve.
 */
export async function buildApp(repoRoot: string): Promise<BuildResult> {
  const out = installRoot();
  const agentOut = path.join(out, "agent");
  fs.mkdirSync(agentOut, { recursive: true });

  // 1. Web UI.
  step("Building web UI (vite)");
  await execa("pnpm", ["--filter", "@atelier/web", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ATELIER_PACKAGE: "1" },
  });
  const builtWeb = path.join(repoRoot, "apps", "web", "dist");
  copyDir(builtWeb, webDist());
  ok("Web UI built");

  // 2. Bundle the agent (our code minified; deps external).
  step("Bundling agent (esbuild)");
  const agentPkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "apps", "agent", "package.json"), "utf8")
  ) as { dependencies?: Record<string, string> };
  const allDeps = Object.keys(agentPkg.dependencies ?? {});
  // Bundle our workspace packages; keep third-party deps external so the
  // agent's node_modules stays small and native builds are reused.
  const external = allDeps.filter((d) => !d.startsWith("@atelier/"));

  const cjsShim = {
    // Shim CJS globals some deps expect under ESM.
    js: "import{createRequire as ___cr}from'module';const require=___cr(import.meta.url);",
  };
  const shared = {
    bundle: true,
    minify: true,
    platform: "node" as const,
    format: "esm" as const,
    target: "node20",
    external,
    banner: cjsShim,
    logLevel: "warning" as const,
  };
  // Two flat outfiles (not outdir) so parse-worker.mjs sits beside
  // main.mjs, where ParserPool looks for it.
  await esbuild({
    ...shared,
    entryPoints: [path.join(repoRoot, "apps", "agent", "src", "main.ts")],
    outfile: path.join(agentOut, "main.mjs"),
  });
  await esbuild({
    ...shared,
    entryPoints: [
      path.join(
        repoRoot,
        "apps",
        "agent",
        "src",
        "knowledge",
        "parsing",
        "parse-worker.ts"
      ),
    ],
    outfile: path.join(agentOut, "parse-worker.mjs"),
  });
  // The supervisor entry: serves the UI + projects.* API and spawns one
  // agent (main.mjs) per project. It points agents at main.mjs via
  // ATELIER_AGENT_ENTRY, set by the CLI at launch.
  await esbuild({
    ...shared,
    entryPoints: [
      path.join(repoRoot, "apps", "agent", "src", "supervisor", "supervisor-main.ts"),
    ],
    outfile: path.join(agentOut, "supervisor-main.mjs"),
  });
  // Assets the bundle reads relative to itself.
  fs.copyFileSync(
    path.join(repoRoot, "apps", "agent", "src", "storage", "schema.sql"),
    path.join(agentOut, "schema.sql")
  );
  ok("Agent bundled");

  // 3. Install external deps so native/wasm packages resolve at runtime.
  step("Installing agent runtime dependencies");
  const runtimePkg = {
    name: "atelier-agent-runtime",
    version: "0.1.0",
    private: true,
    type: "module",
    dependencies: Object.fromEntries(
      external.map((d) => [d, agentPkg.dependencies![d]!])
    ),
  };
  fs.writeFileSync(
    path.join(agentOut, "package.json"),
    JSON.stringify(runtimePkg, null, 2)
  );
  const npmrc =
    "node-linker=hoisted\n" +
    // Native/asset packages must run their build/postinstall scripts.
    EXTERNAL_NATIVE.map((p) => `# ${p}`).join("\n") +
    "\n";
  fs.writeFileSync(path.join(agentOut, ".npmrc"), npmrc);
  await execa("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: agentOut,
    stdio: "inherit",
  });
  ok("Runtime dependencies installed");

  const version = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
  ).version as string;
  fs.writeFileSync(
    path.join(out, "version.json"),
    JSON.stringify({ version, builtAt: Date.now() }, null, 2)
  );
  info(`Installed to ${out}`);

  return { agentEntry: path.join(agentOut, "main.mjs"), webDir: webDist() };
}

function copyDir(src: string, dest: string): void {
  // On Windows a running agent can still hold a handle on the old bundle,
  // making rmSync throw ENOTEMPTY. Retry, then fall back to overwriting
  // in place so a reinstall never fails just because the app is open.
  try {
    fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // leave the old tree; copies below overwrite file-by-file
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else copyFileWithRetry(s, d);
  }
}

/** copyFileSync, retried: an open handle on the target can transiently
 *  reject the overwrite on Windows. */
function copyFileWithRetry(src: string, dest: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.copyFileSync(src, dest);
      return;
    } catch (error) {
      if (attempt >= 5) throw error;
      const until = Date.now() + 200;
      while (Date.now() < until) {
        // brief spin; fs has no sync sleep and this path is rare
      }
    }
  }
}
