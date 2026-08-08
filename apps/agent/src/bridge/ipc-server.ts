import type pino from "pino";
import type { PortClientFrame, PortServerFrame } from "@atelier/protocol";
import type { EventBus } from "../events/event-bus.js";
import { Router, RpcError } from "./router.js";

/**
 * Structural stand-in for Electron's MessagePortMain — the agent package
 * has no dependency on electron; the port object is handed to us at
 * runtime by the utilityProcess parentPort.
 */
export interface MessagePortLike {
  on(event: "message", cb: (e: { data: unknown }) => void): void;
  on(event: "close", cb: () => void): void;
  start(): void;
  postMessage(message: unknown): void;
  close(): void;
}

/**
 * Serves the agent's RPC surface over Electron MessagePorts — the native
 * replacement for the WebSocket BridgeServer. The transport is a private
 * in-process channel handed over by the desktop main process, so there is
 * no token handshake, no Origin check, and no seq replay; every attached
 * port receives every event (the renderer always subscribes to "*").
 */
export class IpcBridgeServer {
  private ports = new Set<MessagePortLike>();
  private inflight = new Map<MessagePortLike, Map<number, AbortController>>();

  constructor(
    private router: Router,
    bus: EventBus,
    private log: pino.Logger
  ) {
    bus.subscribe((event) => {
      this.broadcast({
        kind: "event",
        topic: event.topic,
        ts: event.ts,
        taskId: event.taskId,
        payload: event.payload,
      });
    });
  }

  private broadcast(frame: PortServerFrame): void {
    for (const port of this.ports) port.postMessage(frame);
  }

  /** Serve RPCs on a renderer port until it closes. */
  attach(port: MessagePortLike): void {
    this.ports.add(port);
    this.inflight.set(port, new Map());

    port.on("message", (event) => {
      const frame = event.data as PortClientFrame;
      if (frame?.kind === "rpc") void this.handleRpc(port, frame);
      else if (frame?.kind === "cancel") {
        this.inflight.get(port)?.get(frame.id)?.abort();
      }
    });
    port.on("close", () => this.detach(port));
    port.start();
    port.postMessage({ kind: "ready" } satisfies PortServerFrame);
  }

  private detach(port: MessagePortLike): void {
    for (const controller of this.inflight.get(port)?.values() ?? []) {
      controller.abort();
    }
    this.inflight.delete(port);
    this.ports.delete(port);
  }

  private async handleRpc(
    port: MessagePortLike,
    frame: Extract<PortClientFrame, { kind: "rpc" }>
  ): Promise<void> {
    const controller = new AbortController();
    this.inflight.get(port)?.set(frame.id, controller);
    try {
      const result = await this.router.dispatch(frame.method, frame.params, {
        connectionId: "ipc",
        authenticated: true,
        progress: (value) =>
          port.postMessage({
            kind: "progress",
            id: frame.id,
            value,
          } satisfies PortServerFrame),
        signal: controller.signal,
      });
      port.postMessage({
        kind: "result",
        id: frame.id,
        ok: true,
        result,
      } satisfies PortServerFrame);
    } catch (error) {
      const bridgeError =
        error instanceof RpcError
          ? error.toBridgeError()
          : {
              code: "INTERNAL",
              message: error instanceof Error ? error.message : String(error),
            };
      this.log.debug({ method: frame.method, err: bridgeError }, "rpc failed");
      port.postMessage({
        kind: "result",
        id: frame.id,
        ok: false,
        error: { code: bridgeError.code, message: bridgeError.message },
      } satisfies PortServerFrame);
    } finally {
      this.inflight.get(port)?.delete(frame.id);
    }
  }

  close(): void {
    for (const port of [...this.ports]) {
      port.close();
    }
    this.ports.clear();
    this.inflight.clear();
  }
}
