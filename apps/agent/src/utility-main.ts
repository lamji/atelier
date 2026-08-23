/**
 * Agent entry point for the native desktop app. Forked ONCE as an Electron
 * utilityProcess by the desktop's ProjectManager and shared by every open
 * workspace:
 *
 *   1. main posts {type:"init"} — process-level, names no project
 *   2. we reply {type:"ready"}; no workspace exists yet
 *   3. each {type:"attach", projectId, workspaceRoot, dataDir} carries a
 *      MessagePort for a renderer; the workspace it names is created on
 *      first sight and kept warm afterwards
 *   4. {type:"close"} drops one workspace; {type:"shutdown"} ends the
 *      process
 *
 * workspaceRoot is explicit and validated per workspace — there is no cwd
 * fallback anywhere.
 */
import pino from "pino";
import { disableAsar } from "./workspace/no-asar.js";
import type {
  AgentControlMessage,
  AgentInitMessage,
  AgentParentMessage,
} from "@atelier/protocol";
import { WorkspaceHost } from "./workspace-host.js";
import type { MessagePortLike } from "./bridge/ipc-server.js";

// Before anything reads the filesystem: this host walks user workspaces, and
// Electron's fs shim turns any *.asar path inside one into a thrown error.
disableAsar();

interface ParentPort {
  on(event: "message", cb: (e: { data: unknown; ports: unknown[] }) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort })
  .parentPort;
if (!parentPort) {
  console.error("utility-main must run as an Electron utilityProcess");
  process.exit(1);
}

const send = (message: AgentParentMessage): void =>
  parentPort.postMessage(message);

let host: WorkspaceHost | null = null;

function boot(init: AgentInitMessage): void {
  const log = pino({ level: init.logLevel ?? "info" });
  log.info("starting atelier agent host");
  host = new WorkspaceHost(log, {
    onOpened: (projectId) => send({ type: "opened", projectId }),
    onStatus: (projectId, working) =>
      send({ type: "status", projectId, working }),
  });
  send({ type: "ready" });
}

function shutdown(): void {
  host?.shutdown();
  process.exit(0);
}

/**
 * A workspace that fails to start must not take the host down with it —
 * the other projects are still serving. Report it against its own id and
 * leave everything else running.
 */
function guard(projectId: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    send({
      type: "fatal",
      projectId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

parentPort.on("message", (event) => {
  const message = event.data as AgentInitMessage | AgentControlMessage;
  if (message.type === "init") {
    boot(message);
    return;
  }
  if (!host) return;
  if (message.type === "attach") {
    const port = event.ports[0];
    if (!port) return;
    guard(message.projectId, () =>
      host?.attach(message, port as MessagePortLike)
    );
  } else if (message.type === "open") {
    guard(message.projectId, () => void host?.open(message));
  } else if (message.type === "close") {
    host.close(message.projectId);
  } else if (message.type === "shutdown") {
    shutdown();
  }
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
