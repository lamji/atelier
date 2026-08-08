/**
 * ONE agent utilityProcess for every project.
 *
 * It used to be one process per project, which made opening a workspace
 * cost a process start — native modules, the SDK and the schema, every
 * time — and that was most of what made switching feel slow. Now the host
 * is forked once and the workspace rides on the attach message, so the
 * second project costs a runtime rather than a process and returning to
 * one already open costs nothing.
 *
 * No ports, no tokens, no bridge.json: attach() mints a fresh
 * MessageChannel each time so a reloaded renderer never inherits a dead
 * port. Workspaces stay warm until stop()/shutdown, which is what keeps
 * background workspaces' agents working.
 *
 * The cost, accepted knowingly: projects no longer have process isolation.
 * A crash in the host takes every open workspace with it, so the exit
 * handler marks them all and the next attach re-forks.
 */
import fs from "node:fs";
import path from "node:path";
import { app, MessageChannelMain, utilityProcess } from "electron";
import type { AgentInitMessage, AgentParentMessage } from "@atelier/protocol";
import { ProjectRegistry, atelierDataRoot, type ProjectRecord } from "./registry";

export type ProjectRunState = "stopped" | "starting" | "running" | "error";

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  status: ProjectRunState;
  /** Agent is actively doing work (not merely alive). */
  working: boolean;
  lastOpenedAt?: number;
  error?: string;
}

/** One open workspace inside the shared host process. */
interface OpenWorkspace {
  state: ProjectRunState;
  working: boolean;
  error?: string;
  ready: Promise<void>;
}

const READY_TIMEOUT_MS = 30_000;

export class ProjectManager {
  private registry = new ProjectRegistry();
  private workspaces = new Map<string, OpenWorkspace>();
  private listeners = new Set<(projects: ProjectInfo[]) => void>();
  /** The shared agent host; forked on first use, re-forked after a crash. */
  private host: Electron.UtilityProcess | null = null;
  private hostReady: Promise<void> | null = null;
  /** Resolvers for workspaces waiting on their "opened" message. */
  private pendingOpens = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(private agentEntry: string) {}

  /** Subscribe to any project list/status change. */
  onChanged(cb: (projects: ProjectInfo[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    const snapshot = this.list();
    for (const cb of this.listeners) cb(snapshot);
  }

  list(): ProjectInfo[] {
    return this.registry.list().map((record) => this.info(record));
  }

  private info(record: ProjectRecord): ProjectInfo {
    const workspace = this.workspaces.get(record.id);
    return {
      id: record.id,
      name: record.name,
      path: record.path,
      status: workspace?.state ?? "stopped",
      working: workspace?.working ?? false,
      lastOpenedAt: record.lastOpenedAt,
      error: workspace?.error,
    };
  }

  add(workspacePath: string): ProjectInfo {
    const abs = path.resolve(workspacePath);
    if (!fs.statSync(abs).isDirectory()) {
      throw new Error(`not a directory: ${abs}`);
    }
    const record = this.registry.add(abs);
    this.emit();
    return this.info(record);
  }

  /** Forks the shared host, or returns the promise for the one starting. */
  private ensureHost(): Promise<void> {
    if (this.hostReady) return this.hostReady;

    const logDir = path.join(atelierDataRoot(), "logs");
    fs.mkdirSync(logDir, { recursive: true });

    // A leaked ELECTRON_RUN_AS_NODE (e.g. from a parent launcher) would
    // change how the fork boots — strip it from a copy of the env.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") {
        env[key] = value;
      }
    }
    const child = utilityProcess.fork(this.agentEntry, [], {
      serviceName: "atelier-agent",
      stdio: "pipe",
      env,
    });
    this.host = child;

    const logFile = fs.createWriteStream(path.join(logDir, "agent.log"), {
      flags: "a",
    });
    child.stdout?.pipe(logFile);
    child.stderr?.pipe(logFile);

    child.on("message", (message: AgentParentMessage) => {
      this.onHostMessage(message);
    });
    child.on("exit", (code) => this.onHostExit(code));

    this.hostReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error("agent host did not become ready in time");
        child.kill();
        reject(error);
      }, READY_TIMEOUT_MS);
      const onMessage = (message: AgentParentMessage): void => {
        if (message.type === "ready") {
          clearTimeout(timer);
          resolve();
        }
      };
      child.on("message", onMessage);
    });
    // Callers await this; a detached rejection must not crash the process.
    this.hostReady.catch(() => undefined);
    const init: AgentInitMessage = {
      type: "init",
      logLevel: process.env.LOG_LEVEL,
    };
    child.postMessage(init);
    return this.hostReady;
  }

  private onHostMessage(message: AgentParentMessage): void {
    if (message.type === "opened") {
      const workspace = this.workspaces.get(message.projectId);
      if (workspace) {
        workspace.state = "running";
        workspace.error = undefined;
      }
      this.pendingOpens.get(message.projectId)?.resolve();
      this.emit();
    } else if (message.type === "status") {
      const workspace = this.workspaces.get(message.projectId);
      if (workspace && workspace.working !== message.working) {
        workspace.working = message.working;
        this.emit();
      }
    } else if (message.type === "fatal") {
      // A workspace-scoped failure marks that workspace; a host-wide one
      // (no projectId) marks everything currently open.
      const ids = message.projectId
        ? [message.projectId]
        : [...this.workspaces.keys()];
      for (const id of ids) {
        const workspace = this.workspaces.get(id);
        if (workspace) {
          workspace.state = "error";
          workspace.error = message.message;
        }
        this.pendingOpens.get(id)?.reject(new Error(message.message));
      }
      this.emit();
    }
  }

  /** The host died: every open workspace went with it. */
  private onHostExit(code: number | undefined): void {
    this.host = null;
    this.hostReady = null;
    const reason = `agent host exited with code ${code ?? -1}`;
    for (const [id, workspace] of this.workspaces) {
      workspace.state = code === 0 ? "stopped" : "error";
      if (code !== 0) workspace.error = reason;
      this.pendingOpens.get(id)?.reject(new Error(reason));
    }
    // Nothing is running any more; the next attach re-forks and reopens.
    this.workspaces.clear();
    this.emit();
  }

  private settleOpen(id: string): void {
    const pending = this.pendingOpens.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingOpens.delete(id);
  }

  async start(id: string): Promise<void> {
    const record = this.registry.get(id);
    if (!record) throw new Error(`unknown project: ${id}`);
    const existing = this.workspaces.get(id);
    if (existing && existing.state !== "error") {
      await existing.ready;
      return;
    }

    await this.ensureHost();
    const host = this.host;
    if (!host) throw new Error("agent host is not running");

    const workspace: OpenWorkspace = {
      state: "starting",
      working: false,
      ready: Promise.resolve(),
    };
    workspace.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        workspace.state = "error";
        workspace.error = "workspace did not open in time";
        this.settleOpen(id);
        this.emit();
        reject(new Error(workspace.error));
      }, READY_TIMEOUT_MS);
      this.pendingOpens.set(id, {
        resolve: () => {
          this.settleOpen(id);
          this.registry.touch(id);
          resolve();
        },
        reject: (error) => {
          this.settleOpen(id);
          reject(error);
        },
        timer,
      });
    });
    workspace.ready.catch(() => undefined);

    this.workspaces.set(id, workspace);
    this.emit();

    host.postMessage({
      type: "open",
      projectId: record.id,
      workspaceRoot: record.path,
      dataDir: record.dataDir,
    });

    await workspace.ready;
  }

  /**
   * Fresh MessageChannel into the host, tagged with the workspace it is
   * for. One end goes to the agent, the other is returned for transfer to
   * the renderer.
   */
  async attach(id: string): Promise<Electron.MessagePortMain> {
    const record = this.registry.get(id);
    if (!record) throw new Error(`unknown project: ${id}`);
    await this.start(id);
    const host = this.host;
    if (!host) throw new Error("agent host is not running");
    const { port1, port2 } = new MessageChannelMain();
    host.postMessage(
      {
        type: "attach",
        projectId: record.id,
        workspaceRoot: record.path,
        dataDir: record.dataDir,
      },
      [port1]
    );
    this.registry.touch(id);
    return port2;
  }

  /** Closes one workspace; the host and other workspaces stay up. */
  stop(id: string): void {
    if (!this.workspaces.delete(id)) return;
    this.settleOpen(id);
    this.host?.postMessage({ type: "close", projectId: id });
    this.emit();
  }

  remove(id: string): void {
    this.stop(id);
    this.registry.remove(id);
    this.emit();
  }

  shutdown(): void {
    this.workspaces.clear();
    this.pendingOpens.clear();
    this.host?.kill();
    this.host = null;
    this.hostReady = null;
  }
}

/** Where the agent bundle lives: packaged resources, or the dev build. */
export function resolveAgentEntry(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "agent", "utility-main.mjs");
  }
  const override = process.env.ATELIER_AGENT_ENTRY;
  if (override) return override;
  return path.join(
    app.getAppPath(),
    "..",
    "agent",
    "dist-electron",
    "utility-main.mjs"
  );
}
