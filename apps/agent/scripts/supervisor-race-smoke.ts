/**
 * Regression smoke for concurrent project starts. Boots the supervisor with
 * an initial project and races a second projects.start against it — the case
 * that used to hand both agents the same port (one died with EADDRINUSE while
 * the supervisor still reported it "running", pointing the UI at the wrong
 * project's bridge). Run:
 *   pnpm --filter @atelier/agent exec tsx scripts/supervisor-race-smoke.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@atelier/protocol";
import { atelierDataRoot, projectDataDir, portInUse } from "@atelier/shared/node";

const HUB_PORT = 43198;
const isWindows = process.platform === "win32";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitPort(port: number, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portInUse(port)) return;
    await sleep(200);
  }
  throw new Error(`port ${port} never came up`);
}

class Rpc {
  private ws: WebSocket;
  private pending = new Map<string, (v: any) => void>();
  private id = 0;
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.kind === "res") this.pending.get(frame.id)?.(frame);
    });
  }
  open() {
    return new Promise<void>((res) => this.ws.once("open", () => res()));
  }
  call(method: string, params: unknown): Promise<any> {
    const id = `r${++this.id}`;
    this.ws.send(JSON.stringify({ kind: "req", id, method, params }));
    return new Promise((res) => this.pending.set(id, res));
  }
  close() {
    this.ws.close();
  }
}

/** This hub's own discovery file, falling back to the canonical one. */
function hubToken(port: number): string {
  const root = atelierDataRoot();
  for (const file of [`hub-${port}.json`, "hub.json"]) {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
      if (typeof info.token === "string") return info.token;
    } catch {
      // try the next candidate
    }
  }
  throw new Error("no hub discovery file");
}

function makeProject(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `atelier-race-${label}-`));
  fs.writeFileSync(path.join(dir, "hello.txt"), "hi");
  return dir;
}

/** The port an agent actually bound, per its own bridge.json. */
function bridgePort(project: string): number {
  const file = path.join(projectDataDir(project), "bridge.json");
  return JSON.parse(fs.readFileSync(file, "utf8")).port;
}

async function main() {
  const first = makeProject("a");
  const second = makeProject("b");
  console.log("temp projects:\n ", first, "\n ", second);

  const sup = spawn("pnpm", ["--filter", "@atelier/agent", "supervisor"], {
    shell: true,
    stdio: "inherit",
    env: {
      ...process.env,
      ATELIER_HUB_PORT: String(HUB_PORT),
      ATELIER_INITIAL_PROJECT: first,
      LOG_LEVEL: "warn",
    },
  });

  let failed = false;
  try {
    await waitPort(HUB_PORT);
    const rpc = new Rpc(HUB_PORT);
    await rpc.open();
    const hello = await rpc.call("session.hello", {
      token: hubToken(HUB_PORT),
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "race-smoke", version: "0" },
    });
    if (!hello.ok) throw new Error("hello failed");

    // Race the boot auto-start: add + start a second project immediately,
    // while the initial project's agent is spawned but not yet listening.
    const added = await rpc.call("projects.add", { path: second });
    const secondId = added.result.project.id;
    const startedSecond = await rpc.call("projects.start", { id: secondId });
    const secondEndpoint = startedSecond.result.endpoint;
    if (!secondEndpoint) throw new Error("second project failed to start");

    const list = await rpc.call("projects.list", {});
    const projects = list.result.projects as any[];
    const firstEntry = projects.find((p) => p.path === path.resolve(first));
    if (!firstEntry) throw new Error("initial project not registered");

    // The initial start may still be in flight; ask for its endpoint too.
    const startedFirst = await rpc.call("projects.start", { id: firstEntry.id });
    const firstEndpoint = startedFirst.result.endpoint;
    if (!firstEndpoint) throw new Error("initial project failed to start");

    console.log("ports:", firstEndpoint.port, secondEndpoint.port);
    if (firstEndpoint.port === secondEndpoint.port) {
      throw new Error(`both agents were given port ${firstEndpoint.port}`);
    }

    // Each endpoint must match what that agent actually bound — the old
    // readiness probe accepted another project's listener on the port.
    for (const [dir, endpoint] of [
      [first, firstEndpoint],
      [second, secondEndpoint],
    ] as const) {
      const bound = bridgePort(dir);
      console.log(path.basename(dir), "bound", bound, "endpoint", endpoint.port);
      if (bound !== endpoint.port) {
        throw new Error(`endpoint ${endpoint.port} != bound ${bound}`);
      }
      if (!(await portInUse(endpoint.port))) {
        throw new Error(`nothing listening on ${endpoint.port}`);
      }
    }

    const after = await rpc.call("projects.list", {});
    const stillRunning = (after.result.projects as any[]).filter(
      (p) => p.id === firstEntry.id || p.id === secondId
    );
    console.log("statuses:", stillRunning.map((p) => p.status).join(", "));
    if (stillRunning.some((p) => p.status !== "running")) {
      throw new Error("an agent died after start");
    }

    console.log("initialId:", after.result.initialId);
    if (after.result.initialId !== firstEntry.id) {
      throw new Error("initialId does not point at the launching project");
    }

    await rpc.call("projects.stop", { id: firstEntry.id });
    await rpc.call("projects.stop", { id: secondId });
    await rpc.call("projects.remove", { id: firstEntry.id });
    await rpc.call("projects.remove", { id: secondId });
    rpc.close();
    console.log("\nRACE SMOKE PASSED");
  } catch (err) {
    failed = true;
    console.error("\nRACE SMOKE FAILED:", err);
  } finally {
    if (sup.pid) {
      if (isWindows) {
        try {
          execSync(`taskkill /PID ${sup.pid} /T /F`, { stdio: "ignore" });
        } catch {
          // already gone
        }
      } else sup.kill("SIGTERM");
    }
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

main();
