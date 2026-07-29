import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import pino from "pino";
import { PROTOCOL_VERSION } from "@atelier/protocol";
import { newId } from "@atelier/shared";
import { atelierDataRoot } from "@atelier/shared/node";
import type { AgentConfig } from "../config/agent-config.js";
import type { BridgeInfo } from "../config/token.js";
import { EventBus } from "../events/event-bus.js";
import type { TimelineStore } from "../events/timeline-store.js";
import { Router, RpcError } from "../bridge/router.js";
import { EventHub } from "../bridge/event-hub.js";
import { BridgeServer } from "../bridge/server.js";
import { WebHost } from "../bridge/web-host.js";
import { ProjectRegistry, type ProjectRecord } from "./registry.js";
import { AgentSupervisor, type AgentLauncher } from "./agent-supervisor.js";

const DEFAULT_HUB_PORT = 43100;

function createLogger(): pino.Logger {
  const level = process.env.LOG_LEVEL ?? "info";
  if (process.stdout.isTTY) {
    try {
      return pino({ transport: { target: "pino-pretty" }, level });
    } catch {
      // pino-pretty not installed (packaged build)
    }
  }
  return pino({ level });
}

/** Read a hub discovery file, or null when absent/unreadable. */
function readHubFile(file: string): BridgeInfo | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as BridgeInfo;
  } catch {
    return null;
  }
}

/**
 * Reuse a stable hub token across restarts so a live UI keeps working.
 *
 * Each hub also writes a per-port `hub-<port>.json`: several supervisors
 * can run at once (one per project in dev), and a single shared file would
 * leave every UI but the last one pointed at the wrong port. The canonical
 * `hub.json` is only claimed by the default-port hub (or when it is stale/
 * missing), so `atelier run` keeps finding the primary supervisor.
 */
function loadOrCreateHubInfo(port: number): BridgeInfo {
  const root = atelierDataRoot();
  const canonical = path.join(root, "hub.json");
  const perPort = path.join(root, `hub-${port}.json`);

  const previous = readHubFile(perPort) ?? readHubFile(canonical);
  const token =
    typeof previous?.token === "string" && previous.token.length >= 32
      ? previous.token
      : crypto.randomBytes(32).toString("hex");

  const info: BridgeInfo = {
    port,
    token,
    pid: process.pid,
    startedAt: Date.now(),
  };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(perPort, JSON.stringify(info, null, 2), "utf8");

  const owner = readHubFile(canonical);
  const claimCanonical =
    port === DEFAULT_HUB_PORT || owner === null || owner.port === port;
  if (claimCanonical) {
    fs.writeFileSync(canonical, JSON.stringify(info, null, 2), "utf8");
  }
  return info;
}

/**
 * How to spawn a project's agent. Packaged builds set ATELIER_AGENT_ENTRY to
 * the bundled main.mjs (run with node); dev has no entry, so we launch the
 * agent through pnpm/tsx. Either way, ATELIER_WORKSPACE decides the project.
 */
function makeLauncher(log: pino.Logger): AgentLauncher {
  const entry = process.env.ATELIER_AGENT_ENTRY;
  const stdio: ("ignore" | "inherit")[] = ["ignore", "inherit", "inherit"];
  // No windowsHide: agents share the supervisor's console so that closing
  // that window (the project's terminal) stops them too, rather than
  // leaving orphaned agent processes behind.
  if (entry && fs.existsSync(entry)) {
    return (record: ProjectRecord, env): ChildProcess =>
      spawn(process.execPath, [entry], { cwd: record.path, env, stdio });
  }
  log.warn("ATELIER_AGENT_ENTRY unset — launching agents via pnpm (dev mode)");
  return (record: ProjectRecord, env): ChildProcess =>
    spawn("pnpm", ["--filter", "@atelier/agent", "start"], {
      cwd: process.cwd(),
      shell: true,
      env,
      stdio,
    });
}

function main(): void {
  const log = createLogger();
  const hubPort = Number(process.env.ATELIER_HUB_PORT ?? DEFAULT_HUB_PORT);
  const info = loadOrCreateHubInfo(hubPort);

  const registry = new ProjectRegistry();
  const bus = new EventBus();
  const supervisor = new AgentSupervisor(registry, bus, makeLauncher(log), log);

  // Optionally auto-register + start a first project (the launching cwd).
  // Its id is reported by projects.list so the UI opens the project this
  // instance was launched for, rather than whichever was used last time.
  const initial = process.env.ATELIER_INITIAL_PROJECT;
  let initialId: string | undefined;
  if (initial) {
    const record = registry.add(initial);
    initialId = record.id;
    void supervisor.start(record.id).catch((error) => {
      log.error({ err: error }, "failed to start initial project");
    });
  }

  const config: AgentConfig = {
    workspaceRoot: "",
    dataDir: atelierDataRoot(),
    host: "127.0.0.1",
    port: hubPort,
    agentVersion: "0.1.0",
    webDistPath: webDist(),
  };

  const router = new Router();
  router.register("session.hello", (params) => {
    if (params.protocolVersion !== PROTOCOL_VERSION) {
      throw new RpcError(
        "INVALID_PARAMS",
        `Protocol mismatch: hub=${PROTOCOL_VERSION} client=${params.protocolVersion}`
      );
    }
    return {
      sessionId: newId("sess"),
      agentVersion: config.agentVersion,
      protocolVersion: PROTOCOL_VERSION,
      workspaceRoot: "",
      authStatus: "idle" as const,
    };
  });
  router.register("projects.list", () => ({
    projects: supervisor.list(),
    initialId,
  }));
  router.register("projects.add", (params) => {
    const record = registry.add(params.path);
    const project = supervisor.info(record.id);
    return { project: project! };
  });
  router.register("projects.start", async (params) => ({
    endpoint: await supervisor.start(params.id),
  }));
  router.register("projects.stop", (params) => {
    const project = supervisor.stop(params.id);
    if (!project) throw new RpcError("NOT_FOUND", `unknown project: ${params.id}`);
    return { project };
  });
  router.register("projects.remove", (params) => ({
    ok: supervisor.remove(params.id),
  }));

  // The hub pushes only live status events; no replay is needed.
  const stubTimeline = { replayTopic: () => [] } as unknown as TimelineStore;
  const hub = new EventHub(bus, stubTimeline);
  const webHost = config.webDistPath
    ? new WebHost(
        config.webDistPath,
        info,
        () => ({ ready: true, files: 0, indexed: 0 }),
        "__ATELIER_HUB__"
      )
    : null;
  const server = new BridgeServer(config, info, router, hub, log, webHost);
  server.start();
  log.info(`supervisor listening on port ${hubPort}`);

  const shutdown = (): void => {
    log.info("supervisor shutting down");
    supervisor.shutdown();
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Packaged builds pass ATELIER_WEB_DIST; dev serves the UI via Vite. */
function webDist(): string | undefined {
  const dist = process.env.ATELIER_WEB_DIST;
  return dist && fs.existsSync(dist) ? dist : undefined;
}

main();
