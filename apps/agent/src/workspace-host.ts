import type pino from "pino";
import type { MessagePortLike } from "./bridge/ipc-server.js";
import type { WorkspaceRef } from "@atelier/protocol";
import { resolveConfig } from "./config/agent-config.js";
import { createAgentRuntime, type AgentRuntime } from "./runtime.js";
import { IpcBridgeServer } from "./bridge/ipc-server.js";

/**
 * Every open workspace, inside one agent process.
 *
 * The workspace used to be fixed at fork time — one process per project,
 * so switching projects meant paying for a whole process to start: native
 * modules, the SDK, and the schema, again. Here the root travels with the
 * connection instead: a port arrives naming its workspace, and this
 * resolves (or lazily creates) the services for that root. Opening a
 * second project costs one runtime, not one process, and coming back to a
 * project already open costs nothing at all.
 *
 * The trade this makes, deliberately: workspaces are no longer isolated by
 * an OS process, so one that crashes the process takes the others with it.
 */

interface HostedWorkspace {
  runtime: AgentRuntime;
  server: IpcBridgeServer;
  /** Last reported activity, so only transitions are sent upstream. */
  working: boolean;
}

export interface WorkspaceHostEvents {
  onOpened: (projectId: string) => void;
  onStatus: (projectId: string, working: boolean) => void;
}

export class WorkspaceHost {
  private workspaces = new Map<string, HostedWorkspace>();

  constructor(
    private log: pino.Logger,
    private events: WorkspaceHostEvents
  ) {}

  /**
   * The workspace for `ref`, started if this is the first time it is seen.
   * Synchronous by construction: the runtime is wired eagerly, exactly as
   * it was at fork time — the saving is that the process around it already
   * exists and its modules are already loaded.
   */
  open(ref: WorkspaceRef): HostedWorkspace {
    const existing = this.workspaces.get(ref.projectId);
    if (existing) return existing;

    const config = resolveConfig(ref);
    this.log.info({ workspaceRoot: config.workspaceRoot }, "opening workspace");
    const runtime = createAgentRuntime(config, this.log);
    const server = new IpcBridgeServer(runtime.router, runtime.bus, this.log);
    const hosted: HostedWorkspace = { runtime, server, working: false };
    this.workspaces.set(ref.projectId, hosted);

    // Activity signal for workspace badges: any bus traffic can change
    // whether a task is running, so recompute on each event (cheap) and
    // report only transitions — now tagged with which workspace it is.
    runtime.bus.subscribe(() => {
      const working = runtime.orchestrator.listRunningTaskIds().length > 0;
      if (working !== hosted.working) {
        hosted.working = working;
        this.events.onStatus(ref.projectId, working);
      }
    });

    this.events.onOpened(ref.projectId);
    return hosted;
  }

  /** Serves a renderer port from the workspace that port names. */
  attach(ref: WorkspaceRef, port: MessagePortLike): void {
    this.open(ref).server.attach(port);
  }

  /** Drops one workspace; the process and its other workspaces stay up. */
  close(projectId: string): void {
    const hosted = this.workspaces.get(projectId);
    if (!hosted) return;
    this.workspaces.delete(projectId);
    hosted.server.close();
    hosted.runtime.shutdown();
  }

  shutdown(): void {
    for (const id of [...this.workspaces.keys()]) this.close(id);
  }
}
