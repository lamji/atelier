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
/**
 * Streamed topics, mapped to the payload field that carries the text.
 *
 * The chat pair is per-token; the output pair is per-stdout-chunk, which
 * during a failing test suite is thousands of frames feeding a console pane
 * that repaints at most once per frame anyway. All four are pure appends,
 * which is what makes concatenating a run of them lossless.
 */
const DELTA_TOPICS: Record<string, string | undefined> = {
  "chat.message.delta": "delta",
  "agent.thinking.delta": "delta",
  "tool.output": "chunk",
  "validation.output": "chunk",
};

/** One frame's worth of tokens; matches the terminal dock's own flush. */
const DELTA_FLUSH_MS = 16;

/** A burst this large goes out immediately rather than waiting for the tick. */
const DELTA_FLUSH_BYTES = 8 * 1024;

interface PendingDeltas {
  key: string;
  field: string;
  text: string;
  event: { topic: string; ts: number; taskId?: string; payload: Record<string, unknown> };
}

export class IpcBridgeServer {
  private ports = new Set<MessagePortLike>();
  private inflight = new Map<MessagePortLike, Map<number, AbortController>>();
  /** The delta run currently being accumulated, if any. */
  private pending: PendingDeltas | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private router: Router,
    bus: EventBus,
    private log: pino.Logger
  ) {
    bus.subscribe((event) => {
      if (this.buffer(event)) return;
      // ORDER IS THE WHOLE GAME HERE: anything else must land behind the
      // deltas already buffered, or `chat.message.completed` overtakes the
      // tail of its own message and the transcript ends up truncated.
      this.flushDeltas();
      this.broadcast({
        kind: "event",
        topic: event.topic,
        ts: event.ts,
        taskId: event.taskId,
        payload: event.payload,
      });
    });
  }

  /**
   * Accumulates a streamed delta instead of posting it. Returns true when
   * the event was absorbed.
   *
   * One `postMessage` per token is a structural port crossing plus a
   * renderer store write plus a React render, thousands of times a turn,
   * for text that is being painted a frame at a time anyway. Batching on a
   * frame boundary — the same trick `terminal-manager` already uses for PTY
   * output — collapses that to one crossing per frame with no visible
   * difference in how the answer arrives.
   */
  private buffer(event: {
    topic: string;
    ts: number;
    taskId?: string;
    payload: unknown;
  }): boolean {
    const field = DELTA_TOPICS[event.topic];
    if (!field) return false;
    const payload = event.payload as Record<string, unknown>;
    const delta = payload[field];
    if (typeof delta !== "string") return false;
    // A run is one topic, one stream, one task — message for chat deltas,
    // toolCallId for tool output, validator kind for validation output.
    // Anything else starts a new run, and the old one goes out first so
    // cross-stream order is preserved.
    const key = `${event.topic}|${String(payload.conversationId ?? "")}|${String(
      payload.messageId ?? ""
    )}|${String(payload.toolCallId ?? "")}|${String(payload.kind ?? "")}|${
      event.taskId ?? ""
    }`;
    if (this.pending && this.pending.key !== key) this.flushDeltas();
    if (!this.pending) {
      this.pending = { key, field, text: "", event: { ...event, payload } };
    }
    this.pending.text += delta;
    this.pending.event.ts = event.ts;
    if (this.pending.text.length >= DELTA_FLUSH_BYTES) {
      this.flushDeltas();
      return true;
    }
    this.flushTimer ??= setTimeout(() => this.flushDeltas(), DELTA_FLUSH_MS);
    return true;
  }

  private flushDeltas(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const pending = this.pending;
    this.pending = null;
    if (!pending || !pending.text) return;
    this.broadcast({
      kind: "event",
      topic: pending.event.topic,
      ts: pending.event.ts,
      taskId: pending.event.taskId,
      payload: { ...pending.event.payload, [pending.field]: pending.text },
    } as PortServerFrame);
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
