import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build as esbuild } from "esbuild";
import { execa } from "execa";
import { buildApp } from "./build.js";
import { installRoot } from "./paths.js";
import { runDoctor } from "./doctor.js";
import { banner, step, ok, warn, fail, info, c } from "./ui.js";

export interface InstallOptions {
  repo?: string;
  ref?: string;
  skipDoctor?: boolean;
  noGlobal?: boolean;
}

/**
 * `atelier install` — provisions prerequisites, builds a distributable
 * Atelier into the install directory, and registers the global `atelier`
 * command so `atelier run` works from any project.
 */
export async function install(opts: InstallOptions): Promise<void> {
  banner();

  if (!opts.skipDoctor) {
    const okPrereqs = await runDoctor(true);
    if (!okPrereqs) {
      fail("Missing required prerequisites — install them and re-run.");
      process.exit(1);
    }
  }

  const { repoRoot, cleanup } = await resolveRepo(opts);
  try {
    await buildApp(repoRoot);
    if (!opts.noGlobal) await registerGlobalCommand(repoRoot);
  } finally {
    cleanup();
  }

  console.log();
  ok(c.bold("Atelier installed."));
  info("cd into any project and run:  " + c.cyan("atelier run"));
  console.log();
}

/**
 * Source repo to build from: an explicit --repo clone, else the current
 * repo if the CLI is running inside it.
 */
async function resolveRepo(
  opts: InstallOptions
): Promise<{ repoRoot: string; cleanup: () => void }> {
  if (opts.repo) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-src-"));
    step(`Cloning ${opts.repo}`);
    const args = ["clone", "--depth", "1"];
    if (opts.ref) args.push("--branch", opts.ref);
    args.push(opts.repo, dir);
    await execa("git", args, { stdio: "inherit" });
    ok("Repository cloned");
    return {
      repoRoot: dir,
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
  }
  const local = findRepoRoot(process.cwd());
  if (!local) {
    fail("Not inside the Atelier repo and no --repo <url> given.");
    process.exit(1);
  }
  info(`Building from local repo: ${local}`);
  return { repoRoot: local, cleanup: () => {} };
}

function findRepoRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, "utf8")) as {
          name?: string;
        };
        if (parsed.name === "atelier") return dir;
      } catch {
        // keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Bundles the CLI into the install dir and registers it as the global
 * `atelier` command via npm's global bin (which is already on PATH).
 */
async function registerGlobalCommand(repoRoot: string): Promise<void> {
  step("Registering the `atelier` command");
  const cliOut = path.join(installRoot(), "cli");
  fs.mkdirSync(cliOut, { recursive: true });

  await esbuild({
    entryPoints: [path.join(repoRoot, "apps", "cli", "src", "index.ts")],
    outfile: path.join(cliOut, "atelier.mjs"),
    bundle: true,
    minify: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external: ["esbuild", "execa"],
    banner: {
      js:
        "#!/usr/bin/env node\n" +
        "import{createRequire as ___cr}from'module';" +
        "const require=___cr(import.meta.url);",
    },
    logLevel: "warning",
  });
  fs.writeFileSync(
    path.join(cliOut, "package.json"),
    JSON.stringify(
      {
        name: "atelier",
        version: "0.1.0",
        type: "module",
        bin: { atelier: "atelier.mjs" },
        dependencies: { esbuild: "^0.24.0", execa: "^9.0.0" },
      },
      null,
      2
    )
  );
  await execa("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: cliOut,
    stdio: "inherit",
  });
  const result = await execa("npm", ["install", "-g", cliOut], {
    stdio: "inherit",
    reject: false,
  });
  if (result.exitCode === 0) {
    ok("`atelier` command registered globally");
  } else {
    warn("Could not register globally (npm -g failed).");
    info(`Run manually with: node ${path.join(cliOut, "atelier.mjs")} run`);
  }
}
