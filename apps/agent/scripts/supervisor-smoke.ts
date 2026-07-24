/**
 * Smoke test for the supervisor: boot it, add a project, start a real agent,
 * verify its bridge.json, then stop. Run:
 *   pnpm --filter @atelier/agent exec tsx scripts/supervisor-smoke.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@atelier/protocol";
import { atelierDataRoot, projectDataDir, portInUse } from "@atelier/shared/node";

const HUB_PORT = 43199;
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

async function main() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-smoke-"));
  fs.writeFileSync(path.join(project, "hello.txt"), "hi");
  console.log("temp project:", project);

  const sup = spawn("pnpm", ["--filter", "@atelier/agent", "supervisor"], {
    shell: true,
    stdio: "inherit",
    env: { ...process.env, ATELIER_HUB_PORT: String(HUB_PORT), LOG_LEVEL: "warn" },
  });

  let failed = false;
  try {
    await waitPort(HUB_PORT);
    const hub = JSON.parse(
      fs.readFileSync(path.join(atelierDataRoot(), "hub.json"), "utf8")
    );
    const rpc = new Rpc(HUB_PORT);
    await rpc.open();

    const hello = await rpc.call("session.hello", {
      token: hub.token,
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "smoke", version: "0" },
    });
    console.log("hello ok:", hello.ok);
    if (!hello.ok) throw new Error("hello failed");

    let list = await rpc.call("projects.list", {});
    console.log("initial projects:", list.result.projects.length);

    const added = await rpc.call("projects.add", { path: project });
    const id = added.result.project.id;
    console.log("added project id:", id, "name:", added.result.project.name);

    const started = await rpc.call("projects.start", { id });
    const endpoint = started.result.endpoint;
    console.log("agent endpoint:", endpoint.port, "token?", !!endpoint.token);

    const bridgeFile = path.join(projectDataDir(project), "bridge.json");
    const bridgeOk =
      fs.existsSync(bridgeFile) &&
      JSON.parse(fs.readFileSync(bridgeFile, "utf8")).port === endpoint.port;
    console.log("bridge.json matches endpoint:", bridgeOk);
    if (!bridgeOk) throw new Error("bridge.json mismatch");

    list = await rpc.call("projects.list", {});
    const running = list.result.projects.find((p: any) => p.id === id);
    console.log("project status after start:", running.status);
    if (running.status !== "running") throw new Error("not running");

    const stopped = await rpc.call("projects.stop", { id });
    console.log("status after stop:", stopped.result.project.status);

    await rpc.call("projects.remove", { id });
    rpc.close();
    console.log("\nSMOKE PASSED");
  } catch (err) {
    failed = true;
    console.error("\nSMOKE FAILED:", err);
  } finally {
    if (sup.pid) {
      if (isWindows) {
        try {
          execSync(`taskkill /PID ${sup.pid} /T /F`, { stdio: "ignore" });
        } catch {}
      } else sup.kill("SIGTERM");
    }
    fs.rmSync(project, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

main();
