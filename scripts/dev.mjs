// Sequential dev runner: start the supervisor (which serves the projects.*
// control API and spawns one agent per project), wait until its hub port is
// listening, then start the web UI. If the supervisor fails to start, exit
// loudly instead of letting Vite run against nothing.
//
// Ports are auto-paired so several projects can run side by side:
// hub 43100 -> web 5173, hub 43101 -> web 5174, and so on. Pin either with
// ATELIER_HUB_PORT / ATELIER_WEB_PORT (a pinned port must be free).
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DEFAULT_HUB_PORT = 43100;
const DEFAULT_WEB_PORT = 5173;
const PORT_SCAN_SPAN = 100;
const HUB_READY_TIMEOUT_MS = 30_000;
const isWindows = process.platform === "win32";

/** @type {import("node:child_process").ChildProcess[]} */
const children = [];
let shuttingDown = false;

function prefixPipe(name, stream, out) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) out.write(`[${name}] ${line}\n`);
    }
  });
}

function run(name, args, extraEnv = {}) {
  const child = spawn("pnpm", args, {
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
  children.push(child);
  prefixPipe(name, child.stdout, process.stdout);
  prefixPipe(name, child.stderr, process.stderr);
  return child;
}

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

function tryConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Bind-test a port (catches sockets a connect probe would miss). */
function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

/** First bindable port at or above `start`. */
async function findFreePort(start) {
  for (let port = start; port < start + PORT_SCAN_SPAN; port++) {
    if (await canBind(port)) return port;
  }
  return start;
}

/**
 * A pinned port must be free — silently drifting off an explicitly
 * requested port would point the UI at the wrong project.
 */
async function resolvePinned(port, label) {
  if (await canBind(port)) return port;
  console.error(
    `[dev] ${label} port ${port} is already in use. Free it, or omit the ` +
      "port to let Atelier pick the next one automatically."
  );
  process.exit(1);
}

/** Mirrors atelierDataRoot() in @atelier/shared/node. */
function dataRoot() {
  const base =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "atelier");
}

/** This hub instance's discovery file, written by the supervisor. */
function readHubInfo(port) {
  const file = path.join(dataRoot(), `hub-${port}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

async function waitForHub(supervisor, hubPort) {
  const deadline = Date.now() + HUB_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (supervisor.exitCode !== null) {
      console.error(
        `\n[dev] supervisor exited with code ${supervisor.exitCode} before ` +
          "it was ready. Fix the error above, then rerun."
      );
      shutdown(1);
    }
    if (await tryConnect(hubPort)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(
    `\n[dev] supervisor did not listen on port ${hubPort} within ` +
      `${HUB_READY_TIMEOUT_MS / 1000}s. Check the output above.`
  );
  shutdown(1);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// Pinned ports are honored strictly; unpinned ones scan upward so a second
// project lands on the next free pair instead of failing.
const pinnedHub = process.env.ATELIER_HUB_PORT;
const hubPort = pinnedHub
  ? await resolvePinned(Number(pinnedHub), "hub")
  : await findFreePort(DEFAULT_HUB_PORT);

const pinnedWeb = process.env.ATELIER_WEB_PORT;
const webPort = pinnedWeb
  ? await resolvePinned(Number(pinnedWeb), "web")
  : await findFreePort(DEFAULT_WEB_PORT + (hubPort - DEFAULT_HUB_PORT));

// The first project = the folder `npm run dev` was invoked from (INIT_CWD).
// The supervisor auto-registers and starts it; more are added in the UI.
const workspace =
  process.env.ATELIER_WORKSPACE ?? process.env.INIT_CWD ?? process.cwd();

console.log(`[dev] starting supervisor (initial project: ${workspace})...`);
const supervisor = run("hub", ["--filter", "@atelier/agent", "supervisor"], {
  ATELIER_HUB_PORT: String(hubPort),
  ATELIER_INITIAL_PROJECT: workspace,
});
supervisor.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`\n[dev] supervisor exited unexpectedly (code ${code})`);
    shutdown(code ?? 1);
  }
});

await waitForHub(supervisor, hubPort);
console.log(`[dev] supervisor ready on port ${hubPort}, starting web...`);

// Hand this instance's hub port + token straight to Vite. Reading the
// shared hub.json instead would race whenever two dev servers run.
const info = readHubInfo(hubPort);
if (!info) {
  console.warn(
    `[dev] could not read hub-${hubPort}.json — the UI may need a manual ` +
      "token. Is the supervisor writing to the expected data dir?"
  );
}

const web = run("web", ["--filter", "@atelier/web", "dev"], {
  ATELIER_HUB_PORT: String(hubPort),
  ATELIER_HUB_TOKEN: String(info?.token ?? ""),
  ATELIER_WEB_PORT: String(webPort),
});
web.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`\n[dev] web exited (code ${code})`);
    shutdown(code ?? 1);
  }
});

console.log(`[dev] UI: http://localhost:${webPort}  (hub ${hubPort})`);
