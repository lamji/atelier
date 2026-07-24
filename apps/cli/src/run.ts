import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { execa } from "execa";
import { atelierDataRoot, portInUse } from "@atelier/shared/node";
import { agentEntry, supervisorEntry, webDist } from "./paths.js";
import { banner, step, ok, warn, fail, info, c } from "./ui.js";

export interface RunOptions {
  port?: number;
  noOpen?: boolean;
}

const DEFAULT_HUB_PORT = 43100;

/**
 * `atelier run` — ensures the Atelier supervisor is running (a warm daemon
 * that manages one agent per project), registers the current directory as a
 * project, and opens the web UI. The supervisor keeps running in the
 * background so you can work on several projects at once and switch between
 * them in the app.
 */
export async function run(opts: RunOptions): Promise<void> {
  banner();
  const entry = supervisorEntry();
  if (!fs.existsSync(entry)) {
    fail("Atelier is not installed. Run `atelier install` first.");
    process.exit(1);
  }

  const workspace = process.cwd();
  const hubPort = opts.port ?? readHubPort() ?? DEFAULT_HUB_PORT;
  const url =
    `http://127.0.0.1:${hubPort}/?open=${encodeURIComponent(workspace)}`;

  if (await portInUse(hubPort)) {
    info(`Supervisor already running on port ${hubPort}`);
  } else {
    step(`Starting supervisor on http://127.0.0.1:${hubPort}`);
    startSupervisor(entry, hubPort, workspace);
    await waitForServing(`http://127.0.0.1:${hubPort}`);
    ok("Supervisor ready (running in the background)");
  }

  info(`Opening project: ${workspace}`);
  if (opts.noOpen) {
    ok(`Open ${c.cyan(url)}`);
  } else {
    await openBrowser(url);
    ok(`Opened ${c.cyan(url)}`);
  }
}

/** Spawn the supervisor detached so it outlives this CLI invocation. */
function startSupervisor(
  entry: string,
  hubPort: number,
  workspace: string
): void {
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      ATELIER_HUB_PORT: String(hubPort),
      ATELIER_INITIAL_PROJECT: workspace,
      // Packaged agents are spawned as `node main.mjs`.
      ATELIER_AGENT_ENTRY: agentEntry(),
      ATELIER_WEB_DIST: webDist(),
      LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
    },
  });
  child.unref();
}

function readHubPort(): number | undefined {
  try {
    const file = path.join(atelierDataRoot(), "hub.json");
    const info = JSON.parse(fs.readFileSync(file, "utf8")) as { port?: number };
    return typeof info.port === "number" ? info.port : undefined;
  } catch {
    return undefined;
  }
}

/** Wait until the supervisor's HTTP server answers. */
async function waitForServing(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/atelier/ready`);
      if (res.ok) return;
    } catch {
      // still booting
    }
    await sleep(200);
  }
}

async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const cmd =
    platform === "win32" ? "start" : platform === "darwin" ? "open" : "xdg-open";
  try {
    if (platform === "win32") {
      await execa("cmd", ["/c", "start", "", url], { reject: false });
    } else {
      await execa(cmd, [url], { reject: false });
    }
  } catch {
    warn(`Could not open the browser. Visit ${url}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
