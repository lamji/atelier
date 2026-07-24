// Sequential dev runner: start the supervisor (which serves the projects.*
// control API and spawns one agent per project), wait until its hub port is
// listening, then start the web UI. If the supervisor fails to start, exit
// loudly instead of letting Vite run against nothing.
import { spawn, execSync } from "node:child_process";
import net from "node:net";

const HUB_PORT = Number(process.env.ATELIER_HUB_PORT ?? 43100);
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

async function waitForHub(supervisor) {
  const deadline = Date.now() + HUB_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (supervisor.exitCode !== null) {
      console.error(
        `\n[dev] supervisor exited with code ${supervisor.exitCode} before ` +
          "it was ready. Fix the error above, then rerun."
      );
      shutdown(1);
    }
    if (await tryConnect(HUB_PORT)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(
    `\n[dev] supervisor did not listen on port ${HUB_PORT} within ` +
      `${HUB_READY_TIMEOUT_MS / 1000}s. Check the output above.`
  );
  shutdown(1);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

if (await tryConnect(HUB_PORT)) {
  console.error(
    `[dev] port ${HUB_PORT} is already in use — a supervisor is ` +
      "already running. Stop it first, then rerun."
  );
  process.exit(1);
}

// The first project = the folder `npm run dev` was invoked from (INIT_CWD).
// The supervisor auto-registers and starts it; more are added in the UI.
const workspace =
  process.env.ATELIER_WORKSPACE ?? process.env.INIT_CWD ?? process.cwd();

console.log(`[dev] starting supervisor (initial project: ${workspace})...`);
const supervisor = run("hub", ["--filter", "@atelier/agent", "supervisor"], {
  ATELIER_HUB_PORT: String(HUB_PORT),
  ATELIER_INITIAL_PROJECT: workspace,
});
supervisor.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`\n[dev] supervisor exited unexpectedly (code ${code})`);
    shutdown(code ?? 1);
  }
});

await waitForHub(supervisor);
console.log(`[dev] supervisor ready on port ${HUB_PORT}, starting web...`);

const web = run("web", ["--filter", "@atelier/web", "dev"]);
web.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`\n[dev] web exited (code ${code})`);
    shutdown(code ?? 1);
  }
});
