// Desktop dev orchestrator: composes the existing root scripts/dev.mjs
// (supervisor + Vite, unchanged) and opens an Electron window against the
// Vite dev server. The backend is owned by the root dev runner; Electron
// only hosts the renderer here.
//
// Usage (from repo root): pnpm dev:desktop
// From an external project: set ATELIER_WORKSPACE or run via `atelier debug`
// semantics — INIT_CWD is forwarded exactly like the root runner expects.
import { spawn, execSync } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(desktopRoot, "..", "..");

const DEFAULT_HUB_PORT = 43100;
const DEFAULT_WEB_PORT = 5173;
const PORT_SCAN_SPAN = 100;
const WEB_READY_TIMEOUT_MS = 60_000;
const isWindows = process.platform === "win32";

/** @type {import("node:child_process").ChildProcess[]} */
const children = [];
let shuttingDown = false;

function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (isWindows) {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
    } catch {
      // already gone
    }
  } else {
    child.kill("SIGTERM");
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killTree(child);
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function findFreePort(start) {
  for (let port = start; port < start + PORT_SCAN_SPAN; port++) {
    if (await canBind(port)) return port;
  }
  return start;
}

// Vite may bind ::1 (localhost) rather than 127.0.0.1 on Windows, so probe
// over HTTP with hostname resolution instead of a raw IPv4 socket.
async function isHttpReady(port) {
  try {
    await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(1000),
    });
    return true;
  } catch {
    return false;
  }
}

async function waitFor(child, name, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      console.error(`[desktop] ${name} exited before it was ready`);
      shutdown(1);
    }
    if (await isHttpReady(port)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(`[desktop] ${name} not ready on port ${port} in time`);
  shutdown(1);
}

// Pin the port pair up front so we know the Vite URL before it starts.
// The root runner honors pinned ports strictly (they must be free).
const hubPort = process.env.ATELIER_HUB_PORT
  ? Number(process.env.ATELIER_HUB_PORT)
  : await findFreePort(DEFAULT_HUB_PORT);
const webPort = process.env.ATELIER_WEB_PORT
  ? Number(process.env.ATELIER_WEB_PORT)
  : await findFreePort(DEFAULT_WEB_PORT + (hubPort - DEFAULT_HUB_PORT));

console.log(`[desktop] dev stack: hub ${hubPort}, web ${webPort}`);

const stack = spawn("node", [path.join(repoRoot, "scripts", "dev.mjs")], {
  cwd: repoRoot,
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    ATELIER_HUB_PORT: String(hubPort),
    ATELIER_WEB_PORT: String(webPort),
  },
});
children.push(stack);
stack.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`[desktop] dev stack exited (code ${code})`);
    shutdown(code ?? 1);
  }
});

const bundler = spawn(
  "node",
  [path.join(desktopRoot, "scripts", "bundle.mjs"), "--watch"],
  { cwd: desktopRoot, stdio: ["ignore", "inherit", "inherit"] },
);
children.push(bundler);

await waitFor(stack, "vite", webPort, WEB_READY_TIMEOUT_MS);

const require = createRequire(import.meta.url);
const electronBinary = require("electron");

console.log(`[desktop] launching Electron -> http://localhost:${webPort}`);
const electron = spawn(
  String(electronBinary),
  [path.join(desktopRoot, "dist", "main.cjs")],
  {
    cwd: desktopRoot,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      ATELIER_DEV_URL: `http://localhost:${webPort}`,
    },
  },
);
children.push(electron);
electron.on("exit", (code) => {
  if (!shuttingDown) {
    console.log(`[desktop] window closed, stopping dev stack`);
    shutdown(code ?? 0);
  }
});
