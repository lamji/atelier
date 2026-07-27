import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { banner, step, info, fail, c } from "./ui.js";

export interface DebugOptions {
  /** Hub port. Omit to auto-pick the next free one (43100, 43101, …). */
  port?: number;
  /** Web UI port. Omit to pair it with the hub (5173, 5174, …). */
  webPort?: number;
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
 *
 * Ports are picked automatically, so a second project started this way
 * lands on the next free hub/web pair instead of colliding with the first.
 */
export async function debug(opts: DebugOptions): Promise<void> {
  banner();
  const root = repoRoot();
  const workspace = process.cwd();

  info(`Target project: ${workspace}`);
  step(`Starting Atelier from source: ${root}`);
  if (!opts.port && !opts.webPort) {
    info("Ports: auto (first free hub 43100+, paired web 5173+)");
  }
  console.log();

  const child = spawn("pnpm", ["dev"], {
    cwd: root,
    shell: true,
    stdio: "inherit",
    env: {
      ...process.env,
      ATELIER_WORKSPACE: workspace,
      ...(opts.port ? { ATELIER_HUB_PORT: String(opts.port) } : {}),
      ...(opts.webPort ? { ATELIER_WEB_PORT: String(opts.webPort) } : {}),
    },
  });
  child.on("error", (error) => {
    fail(`Could not start ${c.cyan("pnpm dev")} in ${root}: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}
