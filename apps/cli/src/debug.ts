import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { banner, step, info, fail, c } from "./ui.js";

export interface DebugOptions {
  port?: number;
}

/** Repo root: three levels up from this file (apps/cli/src/debug.ts). */
function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..");
}

/**
 * `atelier debug` — dev-mode run: launches the supervisor + agent + web
 * straight from the Atelier source tree (tsx, no build) pointed at the
 * current directory. For iterating on Atelier itself against any project,
 * without `atelier install`. Requires the Atelier repo's own deps to already
 * be installed (`pnpm install` once, inside the repo).
 */
export async function debug(opts: DebugOptions): Promise<void> {
  banner();
  const root = repoRoot();
  const workspace = process.cwd();

  info(`Target project: ${workspace}`);
  step(`Starting Atelier from source: ${root}`);
  console.log();

  const child = spawn("pnpm", ["dev"], {
    cwd: root,
    shell: true,
    stdio: "inherit",
    env: {
      ...process.env,
      ATELIER_WORKSPACE: workspace,
      ...(opts.port ? { ATELIER_HUB_PORT: String(opts.port) } : {}),
    },
  });
  child.on("error", (error) => {
    fail(`Could not start ${c.cyan("pnpm dev")} in ${root}: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}
