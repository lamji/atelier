// Sequential dev runner: start the agent, wait until its bridge port is
// listening, then start the web UI. If the agent fails to start, exit
// loudly instead of letting Vite run against nothing.
import { spawn, execSync } from "node:child_process";
import net from "node:net";

const AGENT_PORT = Number(process.env.ATELIER_PORT ?? 43110);
const AGENT_READY_TIMEOUT_MS = 30_000;
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

async function waitForAgent(agent) {
  const deadline = Date.now() + AGENT_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (agent.exitCode !== null) {
      console.error(
        `\n[dev] agent exited with code ${agent.exitCode} before ` +
          "it was ready. Fix the agent error above, then rerun."
      );
      shutdown(1);
    }
    if (await tryConnect(AGENT_PORT)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(
    `\n[dev] agent did not listen on port ${AGENT_PORT} within ` +
      `${AGENT_READY_TIMEOUT_MS / 1000}s. It may be hung — check the ` +
      "agent output above."
  );
  shutdown(1);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

if (await tryConnect(AGENT_PORT)) {
  console.error(
    `[dev] port ${AGENT_PORT} is already in use — another agent ` +
      "instance is running. Stop it first, then rerun."
  );
  process.exit(1);
}

// The agent's workspace = the folder `npm run dev` was invoked from
// (INIT_CWD), not apps/agent (pnpm sets cwd to the package dir).
// An explicit ATELIER_WORKSPACE env var still wins.
const workspace =
  process.env.ATELIER_WORKSPACE ?? process.env.INIT_CWD ?? process.cwd();

console.log(`[dev] starting agent (workspace: ${workspace})...`);
const agent = run("agent", ["--filter", "@atelier/agent", "dev"], {
  ATELIER_WORKSPACE: workspace,
});
agent.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`\n[dev] agent exited unexpectedly (code ${code})`);
    shutdown(code ?? 1);
  }
});

await waitForAgent(agent);
console.log(`[dev] agent ready on port ${AGENT_PORT}, starting web...`);

const web = run("web", ["--filter", "@atelier/web", "dev"]);
web.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`\n[dev] web exited (code ${code})`);
    shutdown(code ?? 1);
  }
});
