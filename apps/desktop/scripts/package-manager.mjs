import { spawnSync } from "node:child_process";

/**
 * How to invoke pnpm on THIS machine.
 *
 * The repo is a pnpm workspace, so every script that builds another package
 * shells out to pnpm — and a bare "pnpm" only works if a global shim happens
 * to be on PATH. It often is not: nvm-for-Windows installs Node without
 * corepack shims, and a `nvm use` to a version that never had pnpm installed
 * globally silently removes it. The scripts then died with
 * "'pnpm' is not recognized", which reads as a broken repo rather than a
 * missing shim.
 *
 * Corepack ships with Node and can run pnpm at the version pinned in the
 * root package.json without anything installed globally, so it is the
 * fallback. Resolved once per process.
 */
let resolved;

function works(cmd, args) {
  const probe = spawnSync(cmd, [...args, "--version"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  return probe.status === 0;
}

/** @returns {{cmd: string, prefix: string[]}} */
export function pnpmCommand() {
  if (resolved) return resolved;
  if (works("pnpm", [])) {
    resolved = { cmd: "pnpm", prefix: [] };
  } else if (works("corepack", ["pnpm"])) {
    console.log("[desktop] pnpm not on PATH — using corepack");
    resolved = { cmd: "corepack", prefix: ["pnpm"] };
  } else {
    console.error(
      "[desktop] pnpm is not available. Enable it with `corepack enable` " +
        "(ships with Node), or install it with `npm i -g pnpm`."
    );
    process.exit(1);
  }
  return resolved;
}

/** The command + args for one pnpm invocation, ready to spawn. */
export function pnpmArgs(args) {
  const { cmd, prefix } = pnpmCommand();
  return { cmd, args: [...prefix, ...args] };
}
