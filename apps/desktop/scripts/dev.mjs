// Desktop dev orchestrator — fully native, no supervisor:
//   1. ensure better-sqlite3 in apps/agent is built for the ELECTRON ABI
//      (the agent runs as a utilityProcess on Electron's Node)
//   2. esbuild watch: desktop main+preload, agent utility bundle
//   3. Vite dev server for the renderer
//   4. Electron window (restarted when main/preload rebuild)
//
// Usage (from repo root): pnpm dev:desktop
import { spawn, execSync, spawnSync } from "node:child_process";
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
const agentRoot = path.join(repoRoot, "apps", "agent");

const DEFAULT_WEB_PORT = 5173;
const PORT_SCAN_SPAN = 100;
const WEB_READY_TIMEOUT_MS = 60_000;
// esbuild writes main/preload (and their maps) in a burst; coalesce them into
// one restart. The second delay lets the dying process release the
// single-instance lock — too short and the replacement quits on startup.
const REBUILD_DEBOUNCE_MS = 200;
const RESPAWN_DELAY_MS = 400;
// A window that dies this fast never really opened.
const INSTANT_EXIT_MS = 3000;
const isWindows = process.platform === "win32";

const require = createRequire(import.meta.url);
const electronVersion = require("electron/package.json").version;
const electronBinary = require("electron");

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

// ---------------------------------------------------------------- ABI guard
// better-sqlite3 links against V8 directly; the utilityProcess agent needs
// it built for Electron's ABI, not the system Node that installed it. Track
// the retarget with a marker file keyed by Electron version.
function ensureElectronAbi() {
  // Resolve through the pnpm symlink so prebuild-install (a sibling in the
  // .pnpm virtual store) is findable — `npm run install` inside the linked
  // dir resolves its bin against the wrong base and dies.
  const sqliteDir = fs.realpathSync(
    path.join(agentRoot, "node_modules", "better-sqlite3"),
  );
  const marker = path.join(sqliteDir, ".atelier-electron-abi");
  try {
    if (fs.readFileSync(marker, "utf8").trim() === electronVersion) return;
  } catch {
    // no marker — needs the rebuild
  }
  console.log(
    `[desktop] fetching better-sqlite3 prebuild for electron ${electronVersion}...`,
  );
  const prebuildBin = require.resolve("prebuild-install/bin.js", {
    paths: [sqliteDir],
  });
  const result = spawnSync(
    process.execPath,
    [prebuildBin, "--runtime", "electron", "--target", electronVersion],
    { cwd: sqliteDir, stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error(
      "[desktop] better-sqlite3 electron prebuild failed — close any " +
        "process using the agent (old dev stacks) and retry",
    );
    process.exit(1);
  }
  fs.writeFileSync(marker, electronVersion);
}

function canBindHost(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/**
 * Both stacks, because a free port has to be free on both. Vite binds
 * "localhost", which is IPv4 AND IPv6; probing only 127.0.0.1 called a port
 * held by an IPv6-only listener free, and the launcher then handed Electron
 * a URL that "localhost" resolved to somebody else's dev server — another
 * Vite app on ::1 loads and looks like Atelier failing to boot.
 */
async function canBind(port) {
  for (const host of ["127.0.0.1", "::1"]) {
    if (!(await canBindHost(port, host))) return false;
  }
  return true;
}

async function findFreePort(start) {
  for (let port = start; port < start + PORT_SCAN_SPAN; port++) {
    if (await canBind(port)) return port;
  }
  return start;
}

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

function prefixed(name, args, cwd) {
  const child = spawn("pnpm", args, {
    cwd,
    shell: true,
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  });
  children.push(child);
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`[desktop] ${name} exited (code ${code})`);
      shutdown(code ?? 1);
    }
  });
  return child;
}

/**
 * build/ is gitignored, so a fresh clone has no icon.png and the dev window
 * would fall back to the stock Electron atom. Cheap enough to just render it
 * on every boot; a failure here must never block the dev stack.
 */
function ensureIcon() {
  const result = spawnSync(
    process.execPath,
    [path.join(desktopRoot, "scripts", "build-icon.mjs")],
    { cwd: desktopRoot, stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.warn("[desktop] icon generation failed — using the default icon");
  }
}

// ------------------------------------------------------------------- boot
ensureElectronAbi();
ensureIcon();

const webPort = process.env.ATELIER_WEB_PORT
  ? Number(process.env.ATELIER_WEB_PORT)
  : await findFreePort(DEFAULT_WEB_PORT);

console.log(`[desktop] dev: web ${webPort} (native, no supervisor)`);

// Watchers: desktop main/preload + agent utility bundle.
const desktopBundler = spawn(
  "node",
  [path.join(desktopRoot, "scripts", "bundle.mjs"), "--watch"],
  { cwd: desktopRoot, stdio: ["ignore", "inherit", "inherit"] },
);
children.push(desktopBundler);
const agentBundler = spawn(
  "node",
  [path.join(agentRoot, "scripts", "bundle-electron.mjs"), "--watch"],
  { cwd: agentRoot, stdio: ["ignore", "inherit", "inherit"] },
);
children.push(agentBundler);

process.env.ATELIER_WEB_PORT = String(webPort);
const vite = prefixed(
  "vite",
  ["--filter", "@atelier/web", "dev", "--force", "--port", String(webPort)],
  repoRoot,
);

await waitFor(vite, "vite", webPort, WEB_READY_TIMEOUT_MS);

/** @type {import("node:child_process").ChildProcess | null} */
let electron = null;
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
        ATELIER_AGENT_ENTRY: path.join(
          agentRoot,
          "dist-electron",
          "utility-main.mjs",
        ),
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

// Renderer edits are covered by Vite HMR; main/preload rebuilds need a
// window restart. Watch the built output so restarts land after the bundle
// is actually on disk. (Agent rebuilds do NOT restart the window — a fresh
// agent is picked up on the next project start.)
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
