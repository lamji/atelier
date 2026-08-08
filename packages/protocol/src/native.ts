/**
 * Native (Electron) wire contract — the frames that replace the WebSocket
 * envelope. Three parties share these types:
 *
 *   desktop main  — forks one agent utilityProcess per project and relays
 *                   a MessagePort pair between agent and renderer
 *   agent         — serves RPCs/events over its end of the port
 *   web renderer  — drives the same port through BridgeClient
 *
 * There is no token, no seq replay and no sub/unsub here: the transport is
 * a private in-process channel, and the renderer always consumes every
 * event topic.
 */

/**
 * Main -> agent, first message after fork. Process-level only: one agent
 * process now hosts every open workspace, so nothing here names a project.
 */
export interface AgentInitMessage {
  type: "init";
  logLevel?: string;
}

/** Which workspace a control message is about. */
export interface WorkspaceRef {
  projectId: string;
  /** Absolute path of the workspace. Required — the agent must refuse to
   *  guess (a cwd fallback is how the wrong-folder bug happened). */
  workspaceRoot: string;
  /** Per-project data dir (knowledge DB, settings). */
  dataDir: string;
}

/**
 * Main -> agent after init.
 *
 * `attach` carries a fresh MessagePort AND the workspace it belongs to:
 * the root travels with the connection rather than with the process, which
 * is what lets one agent serve every project and a switch cost nothing but
 * a new port. The workspace is created on first attach and kept warm.
 * `close` disposes one workspace without touching the others.
 */
export type AgentControlMessage =
  | ({ type: "attach" } & WorkspaceRef)
  | ({ type: "open" } & WorkspaceRef)
  | { type: "close"; projectId: string }
  | { type: "shutdown" };

/** Agent -> main over parentPort. */
export type AgentParentMessage =
  /** The host process is up; workspaces are opened on demand. */
  | { type: "ready" }
  /** A workspace finished starting and is serving. */
  | { type: "opened"; projectId: string }
  | { type: "fatal"; projectId?: string; message: string }
  /** Lightweight activity signal so the shell can badge background
   *  workspaces without the renderer holding a port to each of them. */
  | { type: "status"; projectId: string; working: boolean };

/** Renderer -> agent over the MessagePort. */
export type PortClientFrame =
  | { kind: "rpc"; id: number; method: string; params: unknown }
  | { kind: "cancel"; id: number };

/** Agent -> renderer over the MessagePort. */
export type PortServerFrame =
  | { kind: "ready" }
  | { kind: "result"; id: number; ok: true; result: unknown }
  | {
      kind: "result";
      id: number;
      ok: false;
      error: { code: string; message: string };
    }
  | { kind: "progress"; id: number; value: unknown }
  | { kind: "event"; topic: string; ts: number; taskId?: string; payload: unknown };
