import { spawn, execSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Packaged-mode backend launcher. Mirrors `atelier run` semantics
 * (apps/cli/src/run.ts): reuse an already-listening supervisor, otherwise
 * spawn the bundled one. The supervisor and every agent it spawns run on
 * Electron's own Node via ELECTRON_RUN_AS_NODE — the supervisor re-execs
 * process.execPath for agents and passes its env through, so no backend
 * code changes and no system Node is required. ATELIER_NODE_BIN overrides
 * with an external Node binary as an escape hatch.
 */

const DEFAULT_HUB_PORT = 43100;
const PORT_SCAN_SPAN = 100;
const READY_TIMEOUT_MS = 30_000;
const isWindows = process.platform === "win32";

export interface BackendHandle {
  hubPort: number;
  /** True when this process spawned (and must stop) the supervisor. */
  owned: boolean;
}

let child: ChildProcess | null = null;

/** Mirrors atelierDataRoot() in @atelier/shared/node. */
function dataRoot(): string {
  const base =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "atelier");
}

function preferredHubPort(): number {
  // Pinned port wins — same contract as the CLI's --port flag.
  const pinned = Number(process.env.ATELIER_HUB_PORT);
  if (Number.isFinite(pinned) && pinned > 0) return pinned;
  try {
    const raw = fs.readFileSync(path.join(dataRoot(), "hub.json"), "utf8");
    const port = Number((JSON.parse(raw) as { port?: number }).port);
    if (Number.isFinite(port) && port > 0) return port;
  } catch {
    // no hub.json yet
  }
  return DEFAULT_HUB_PORT;
}

async function isHubReady(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/atelier/ready`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function findFreePort(start: number): Promise<number> {
  for (let port = start; port < start + PORT_SCAN_SPAN; port++) {
    if (await canBind(port)) return port;
  }
  return start;
}

function backendResources(): {
  supervisorEntry: string;
  agentEntry: string;
  webDist: string;
} {
  // ATELIER_BACKEND_DIR lets a dev run point at build/backend without
  // packing an installer first.
  const base = process.env.ATELIER_BACKEND_DIR ?? process.resourcesPath;
  return {
    supervisorEntry: path.join(base, "agent", "supervisor-main.mjs"),
    agentEntry: path.join(base, "agent", "main.mjs"),
    webDist: path.join(base, "web"),
  };
}

export function hasPackagedBackend(): boolean {
  try {
    return fs.existsSync(backendResources().supervisorEntry);
  } catch {
    return false;
  }
}

/**
 * Ensure a supervisor is serving; returns its hub port and whether this
 * process owns its lifetime.
 */
export async function ensureBackend(
  initialProject: string | null,
): Promise<BackendHandle> {
  const preferred = preferredHubPort();
  if (await isHubReady(preferred)) {
    // Started by the CLI (or a previous crash-orphan); reuse, don't own.
    return { hubPort: preferred, owned: false };
  }

  const hubPort = (await canBind(preferred))
    ? preferred
    : await findFreePort(preferred + 1);

  const { supervisorEntry, agentEntry, webDist } = backendResources();
  const logsDir = path.join(dataRoot(), "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const log = fs.openSync(
    path.join(logsDir, "desktop-supervisor.log"),
    "a",
  );

  const nodeBin = process.env.ATELIER_NODE_BIN;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ATELIER_HUB_PORT: String(hubPort),
    ATELIER_AGENT_ENTRY: agentEntry,
    ATELIER_WEB_DIST: webDist,
    ...(initialProject ? { ATELIER_INITIAL_PROJECT: initialProject } : {}),
    ...(nodeBin ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
  };

  child = spawn(nodeBin ?? process.execPath, [supervisorEntry], {
    env,
    windowsHide: true,
    stdio: ["ignore", log, log],
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `supervisor exited with code ${child.exitCode} before ready ` +
          `(see ${path.join(logsDir, "desktop-supervisor.log")})`,
      );
    }
    if (await isHubReady(hubPort)) return { hubPort, owned: true };
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`supervisor not ready on port ${hubPort} within 30s`);
}

/** Stop the supervisor tree, but only if this process spawned it. */
export function stopBackend(): void {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  if (isWindows) {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
    } catch {
      // already gone
    }
  } else {
    child.kill("SIGTERM");
  }
  child = null;
}
