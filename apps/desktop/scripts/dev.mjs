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
import fs from "node:fs";
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
// esbuild writes main/preload (and their maps) in a burst; coalesce them into
// one restart. The second delay lets the OS release the window first.
const REBUILD_DEBOUNCE_MS = 200;
// Long enough for the dying process to release the single-instance lock;
// the replacement would otherwise quit on startup instead of taking over.
const RESPAWN_DELAY_MS = 400;
// A window that dies this fast never really opened.
const INSTANT_EXIT_MS = 3000;
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

/** @type {import("node:child_process").ChildProcess | null} */
let electron = null;
// True only across an intentional kill, so the exit handler can tell a
// rebuild restart from the user closing the window.
let restarting = false;

function startElectron() {
  console.log(`[desktop] launching Electron -> http://localhost:${webPort}`);
  const child = spawn(
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
  children.push(child);
  electron = child;
  const spawnedAt = Date.now();
  child.on("exit", (code) => {
    const index = children.indexOf(child);
    if (index !== -1) children.splice(index, 1);
    if (shuttingDown || restarting) return;
    // Electron holds a single-instance lock: a leftover window from a dev
    // run whose parent was killed makes every new one quit on startup. That
    // looks identical to "the user closed the window", so name it.
    if (Date.now() - spawnedAt < INSTANT_EXIT_MS) {
      console.error(
        "[desktop] Electron quit immediately — another Atelier window is\n" +
          "          probably still running and holding the single-instance\n" +
          "          lock. Close it (or kill the leftover electron process)\n" +
          "          and run pnpm dev:desktop again.",
      );
      shutdown(1);
    }
    console.log(`[desktop] window closed, stopping dev stack`);
    shutdown(code ?? 0);
  });
}

function restartElectron() {
  if (shuttingDown || electron === null) return;
  restarting = true;
  killTree(electron);
  electron = null;
  setTimeout(() => {
    restarting = false;
    if (!shuttingDown) startElectron();
  }, RESPAWN_DELAY_MS);
}

/**
 * Renderer edits are covered by Vite HMR, but main/preload run in Node and
 * are only read at process start — the esbuild watcher rebuilds them and the
 * live window would keep running the old code. Watch the built output rather
 * than the sources so the restart lands after the bundle is actually on disk.
 */
function watchForRebuilds() {
  const distDir = path.join(desktopRoot, "dist");
  let timer = null;
  try {
    fs.watch(distDir, (_event, filename) => {
      const name = filename ? String(filename) : "";
      if (name !== "main.cjs" && name !== "preload.cjs") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        console.log(`[desktop] ${name} rebuilt — restarting window`);
        restartElectron();
      }, REBUILD_DEBOUNCE_MS);
    });
  } catch (error) {
    console.warn(`[desktop] auto-restart disabled: ${error.message}`);
  }
}

startElectron();
watchForRebuilds();
