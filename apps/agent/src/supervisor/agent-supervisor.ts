import fs from "node:fs";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import type { Logger } from "pino";
import path from "node:path";
import type { ProjectEndpoint, ProjectInfo } from "@atelier/protocol";
import { freePort, portInUse } from "@atelier/shared/node";
import type { BridgeInfo } from "../config/token.js";
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
  /** In-flight starts, so concurrent start(id) calls share one launch. */
  private starting = new Map<string, Promise<ProjectEndpoint>>();
  /** Ports handed to an agent that may not be listening yet. */
  private reserved = new Set<number>();
  /** Serializes port handout so two launches can't pick the same port. */
  private portLock: Promise<unknown> = Promise.resolve();

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
    // Coalesce concurrent starts. On `atelier run` the boot auto-start races
    // the web's projects.start; without this both would spawn an agent, the
    // two would collide on the same freePort, and the loser's crash would
    // reject the start (and leave a stale bridge.json).
    const inFlight = this.starting.get(id);
    if (inFlight) return inFlight;

    const record = this.registry.get(id);
    if (!record) throw new Error(`unknown project: ${id}`);

    const launch = this.launchAgent(id, record);
    this.starting.set(id, launch);
    this.emit(record);
    try {
      return await launch;
    } finally {
      this.starting.delete(id);
      this.emit(record);
    }
  }

  private async launchAgent(
    id: string,
    record: ProjectRecord
  ): Promise<ProjectEndpoint> {
    const port = await this.reservePort();
    try {
      fs.mkdirSync(record.dataDir, { recursive: true });
      // Taken before the spawn so bridge.json from an earlier run of this
      // same project can never pass as this launch's.
      const launchedAt = Date.now();
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
      const info = await this.waitReady(child, record, port, launchedAt);
      this.running.set(id, { child, port, token: info.token });
      this.registry.touch(id);
      this.log.info({ project: record.name, port }, "agent started");
      return { id, port, token: info.token };
    } catch (error) {
      this.reserved.delete(port);
      throw error;
    }
  }

  /**
   * Claim a port for one agent. Serialized and reservation-aware: a spawned
   * agent does not bind its port for a second or two, so two launches that
   * overlap (the boot auto-start and the UI's projects.start, say) would
   * otherwise both be told the same port and the loser would die with
   * EADDRINUSE.
   */
  private reservePort(): Promise<number> {
    const next = this.portLock.then(async () => {
      const port = await freePort(AGENT_PORT_BASE, 100, this.reserved);
      this.reserved.add(port);
      return port;
    });
    this.portLock = next.catch(() => undefined);
    return next;
  }

  stop(id: string): ProjectInfo | undefined {
    const run = this.running.get(id);
    if (run) {
      killTree(run.child);
      this.running.delete(id);
      this.reserved.delete(run.port);
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
    this.reserved.clear();
  }

  private onExit(id: string, code: number | null): void {
    if (!this.running.has(id) && !this.starting.has(id)) return;
    const run = this.running.get(id);
    if (run) this.reserved.delete(run.port);
    this.running.delete(id);
    const record = this.registry.get(id);
    if (code && code !== 0) {
      this.log.warn({ id, code }, "agent exited unexpectedly");
    }
    if (record) this.emit(record);
  }

  /**
   * Wait until THIS agent owns the port (or it dies). A bare "is the port
   * in use" probe is not enough: another project's agent listening on the
   * same port answers it just as happily, so a crashed agent would be
   * reported as started and the UI handed the wrong project's bridge.
   */
  private async waitReady(
    child: ChildProcess,
    record: ProjectRecord,
    port: number,
    launchedAt: number
  ): Promise<BridgeInfo> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`agent exited (code ${child.exitCode}) before ready`);
      }
      const info = this.readBridgeInfo(record.dataDir, port, launchedAt);
      if (info && (await portInUse(port))) return info;
      await sleep(200);
    }
    throw new Error(`agent did not listen on port ${port} in time`);
  }

  /**
   * The agent writes bridge.json (port + token) just before it listens.
   * Only this launch's file counts — a stale one left by a previous run
   * carries a port that some other agent may hold by now.
   */
  private readBridgeInfo(
    dataDir: string,
    port: number,
    launchedAt: number
  ): BridgeInfo | null {
    try {
      const file = path.join(dataDir, "bridge.json");
      const info = JSON.parse(fs.readFileSync(file, "utf8")) as BridgeInfo;
      const fresh = info.startedAt >= launchedAt && info.port === port;
      return fresh && typeof info.token === "string" ? info : null;
    } catch {
      return null; // not written yet, or half-written
    }
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
