import fs from "node:fs";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import type { Logger } from "pino";
import path from "node:path";
import type { ProjectEndpoint, ProjectInfo } from "@atelier/protocol";
import { freePort, portInUse } from "@atelier/shared/node";
import type { EventBus } from "../events/event-bus.js";
import { ProjectRegistry, type ProjectRecord } from "./registry.js";

const isWindows = process.platform === "win32";
const AGENT_PORT_BASE = 43110;
const READY_TIMEOUT_MS = 30_000;

/**
 * Builds the child process for one project's agent. Injected so packaged
 * mode (`node main.mjs`) and dev mode (`pnpm ... start` via tsx) can differ
 * without the supervisor knowing which runtime it's under.
 */
export type AgentLauncher = (
  record: ProjectRecord,
  env: NodeJS.ProcessEnv
) => ChildProcess;

interface Running {
  child: ChildProcess;
  port: number;
  token: string;
}

/**
 * Owns the per-project agent processes. Each project gets its own port and
 * data dir; agents stay warm until explicitly stopped. Lifecycle changes
 * are published as `project.status` events for the UI.
 */
export class AgentSupervisor {
  private running = new Map<string, Running>();
  private starting = new Set<string>();

  constructor(
    private registry: ProjectRegistry,
    private bus: EventBus,
    private launch: AgentLauncher,
    private log: Logger
  ) {}

  private toInfo(record: ProjectRecord): ProjectInfo {
    const run = this.running.get(record.id);
    const status: ProjectInfo["status"] = run
      ? "running"
      : this.starting.has(record.id)
        ? "starting"
        : "stopped";
    return {
      id: record.id,
      name: record.name,
      path: record.path,
      status,
      port: run?.port,
      lastOpenedAt: record.lastOpenedAt,
    };
  }

  private emit(record: ProjectRecord): void {
    this.bus.publish("project.status", { project: this.toInfo(record) });
  }

  list(): ProjectInfo[] {
    return this.registry.list().map((r) => this.toInfo(r));
  }

  info(id: string): ProjectInfo | undefined {
    const record = this.registry.get(id);
    return record ? this.toInfo(record) : undefined;
  }

  /** Spawn the agent if it isn't already running; return its endpoint. */
  async start(id: string): Promise<ProjectEndpoint> {
    const existing = this.running.get(id);
    if (existing) {
      return { id, port: existing.port, token: existing.token };
    }
    const record = this.registry.get(id);
    if (!record) throw new Error(`unknown project: ${id}`);

    this.starting.add(id);
    this.emit(record);
    try {
      const port = await freePort(AGENT_PORT_BASE);
      fs.mkdirSync(record.dataDir, { recursive: true });
      const child = this.launch(record, {
        ...process.env,
        ATELIER_WORKSPACE: record.path,
        ATELIER_DATA_DIR: record.dataDir,
        ATELIER_PORT: String(port),
        // Headless: the supervisor serves the UI, agents are pure bridges.
        ATELIER_WEB_DIST: "",
        LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
      });
      child.on("exit", (code) => this.onExit(id, code));
      await this.waitReady(child, port);
      const token = this.readToken(record.dataDir);
      this.running.set(id, { child, port, token });
      this.registry.touch(id);
      this.log.info({ project: record.name, port }, "agent started");
      this.emit(record);
      return { id, port, token };
    } finally {
      this.starting.delete(id);
    }
  }

  stop(id: string): ProjectInfo | undefined {
    const run = this.running.get(id);
    if (run) {
      killTree(run.child);
      this.running.delete(id);
    }
    const record = this.registry.get(id);
    if (record) {
      this.emit(record);
      return this.toInfo(record);
    }
    return undefined;
  }

  remove(id: string): boolean {
    this.stop(id);
    return this.registry.remove(id);
  }

  shutdown(): void {
    for (const [, run] of this.running) killTree(run.child);
    this.running.clear();
  }

  private onExit(id: string, code: number | null): void {
    if (!this.running.has(id) && !this.starting.has(id)) return;
    this.running.delete(id);
    const record = this.registry.get(id);
    if (code && code !== 0) {
      this.log.warn({ id, code }, "agent exited unexpectedly");
    }
    if (record) this.emit(record);
  }

  /** Wait until the agent's bridge port accepts connections (or it dies). */
  private async waitReady(child: ChildProcess, port: number): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`agent exited (code ${child.exitCode}) before ready`);
      }
      if (await portInUse(port)) return;
      await sleep(200);
    }
    throw new Error(`agent did not listen on port ${port} in time`);
  }

  /** The agent writes bridge.json (port + token) before it starts listening. */
  private readToken(dataDir: string): string {
    const file = path.join(dataDir, "bridge.json");
    const info = JSON.parse(fs.readFileSync(file, "utf8")) as { token: string };
    return info.token;
  }
}

function killTree(child: ChildProcess): void {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
