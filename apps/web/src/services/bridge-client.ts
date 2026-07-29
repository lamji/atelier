import {
  PROTOCOL_VERSION,
  type BridgeError,
  type EventFrame,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type ServerFrame,
} from "@atelier/protocol";
import { newId } from "@atelier/shared";

declare const __ATELIER_BRIDGE_PORT__: string;
declare const __ATELIER_BRIDGE_TOKEN__: string;

/** Injected by a WebHost when it serves the packaged UI. */
interface InjectedEndpoint {
  port: number | string;
  token: string;
}
declare global {
  interface Window {
    __ATELIER_BRIDGE__?: InjectedEndpoint;
  }
}

/** Resolves where a client connects. Returns null when unknown yet. */
export type EndpointResolver = () => { url: string; token: string } | null;

export interface BridgeClientOptions {
  resolveEndpoint: EndpointResolver;
}

export type EventHandler = (frame: EventFrame) => void;
export type StatusHandler = (
  state:
    | "disconnected"
    | "connecting"
    | "handshaking"
    | "connected"
    | "unauthorized"
) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: BridgeError) => void;
  onProgress?: (value: {
    stage?: string;
    pct?: number;
    message?: string;
    chunk?: string;
  }) => void;
}

interface SubEntry {
  topic: string;
  handler: EventHandler;
  lastSeq: number;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

/**
 * The single WebSocket to the Local Agent. Owns the hello handshake,
 * typed rpc(), topic subscriptions, and reconnect with seq-based replay.
 */
export class BridgeClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private subs = new Map<string, SubEntry>();
  private statusHandlers = new Set<StatusHandler>();
  private reconnectAttempt = 0;
  private closedByUser = false;
  /** Event frames queued for the next coalesced flush (see onFrame). */
  private eventQueue: Array<{ handler: EventHandler; frame: EventFrame }> = [];
  private flushHandle: number | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Runtime endpoint override (set when switching projects). */
  private override: { url: string; token: string } | null = null;
  hello: { workspaceRoot: string; authStatus: string } | null = null;

  constructor(private opts: BridgeClientOptions) {}

  /**
   * Point the client at a specific agent (project switch). Takes effect on
   * the next connect(); callers should disconnect() then connect().
   */
  setEndpoint(endpoint: { port: number | string; token: string }): void {
    this.override = {
      url: `ws://127.0.0.1:${endpoint.port}`,
      token: endpoint.token,
    };
    // Sequence numbers are per agent and restart low, so a seq carried over
    // from the previous project would ask the new one to replay from a
    // point in someone else's stream.
    for (const entry of this.subs.values()) entry.lastSeq = 0;
    this.hello = null;
  }

  clearEndpoint(): void {
    this.override = null;
  }

  private getEndpoint(): { url: string; token: string } | null {
    return this.override ?? this.opts.resolveEndpoint();
  }

  connect(): void {
    this.closedByUser = false;
    const endpoint = this.getEndpoint();
    if (!endpoint) {
      this.emitStatus("disconnected");
      return;
    }
    this.emitStatus("connecting");
    const ws = new WebSocket(endpoint.url);
    this.ws = ws;

    ws.onopen = () => {
      this.emitStatus("handshaking");
      void this.rpc("session.hello", {
        token: endpoint.token,
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "atelier-web", version: "0.1.0" },
      })
        .then((result) => {
          this.hello = {
            workspaceRoot: result.workspaceRoot,
            authStatus: result.authStatus,
          };
          this.reconnectAttempt = 0;
          this.resubscribeAll();
          this.emitStatus("connected");
        })
        .catch(() => {
          this.emitStatus("unauthorized");
          ws.close();
        });
    };
    ws.onmessage = (msg) => this.onFrame(String(msg.data));
    ws.onclose = (ev) => {
      this.failAllPending();
      if (ev.code === 4401) {
        this.emitStatus("unauthorized");
        return;
      }
      this.emitStatus("disconnected");
      if (!this.closedByUser) this.scheduleReconnect();
    };
  }

  disconnect(): void {
    this.closedByUser = true;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      // Detach handlers so the stale socket's onclose can't schedule a
      // reconnect — important when switching projects (disconnect → connect
      // back-to-back against a new endpoint).
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
    }
    this.failAllPending();
    this.clearEventQueue();
    this.reconnectAttempt = 0;
    this.emitStatus("disconnected");
  }

  /** Drops any queued event frames and cancels the pending flush. */
  private clearEventQueue(): void {
    this.eventQueue = [];
    if (this.flushHandle !== null) {
      cancelAnimationFrame(this.flushHandle);
      this.flushHandle = null;
    }
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  rpc<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    onProgress?: Pending["onProgress"]
  ): Promise<MethodResult<M>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject({
        code: "INTERNAL",
        message: "bridge not connected",
      } satisfies BridgeError);
    }
    const id = newId("req");
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        onProgress,
      });
      ws.send(JSON.stringify({ kind: "req", id, method, params }));
    });
  }

  cancel(requestOrTaskId: string): void {
    this.ws?.send(JSON.stringify({ kind: "cancel", id: requestOrTaskId }));
  }

  /** Subscribe to a topic pattern; survives reconnects with seq replay. */
  subscribe(topic: string, handler: EventHandler): () => void {
    const subId = newId("sub");
    this.subs.set(subId, { topic, handler, lastSeq: 0 });
    this.sendSub(subId);
    return () => {
      this.subs.delete(subId);
      this.ws?.send(JSON.stringify({ kind: "unsub", subId }));
    };
  }

  private sendSub(subId: string): void {
    const entry = this.subs.get(subId);
    const ws = this.ws;
    if (!entry || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        kind: "sub",
        id: subId,
        topic: entry.topic,
        since: entry.lastSeq || undefined,
      })
    );
  }

  private resubscribeAll(): void {
    for (const subId of this.subs.keys()) this.sendSub(subId);
  }

  private onFrame(raw: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      return;
    }
    if (frame.kind === "res") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      if (frame.ok) {
        pending.resolve(frame.result);
      } else {
        pending.reject(
          frame.error ?? { code: "INTERNAL", message: "unknown error" }
        );
      }
    } else if (frame.kind === "progress") {
      this.pending.get(frame.id)?.onProgress?.(frame.value);
    } else if (frame.kind === "event") {
      for (const entry of this.subs.values()) {
        if (topicMatches(entry.topic, frame.topic)) {
          if (frame.seq > entry.lastSeq) entry.lastSeq = frame.seq;
          this.eventQueue.push({ handler: entry.handler, frame });
        }
      }
      this.scheduleFlush();
    }
  }

  /**
   * Coalesces a burst of event frames into one flush per animation frame so
   * React 18/19 auto-batching merges the resulting store updates into a
   * single render. A setTimeout safety net covers backgrounded tabs, where
   * rAF is throttled/paused.
   */
  private scheduleFlush(): void {
    if (this.flushHandle !== null || this.flushTimer !== null) return;
    this.flushHandle = requestAnimationFrame(() => this.flushEvents());
    this.flushTimer = setTimeout(() => this.flushEvents(), 100);
  }

  private flushEvents(): void {
    if (this.flushHandle !== null) {
      cancelAnimationFrame(this.flushHandle);
      this.flushHandle = null;
    }
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Swap the queue out before delivering so a handler that triggers
    // another frame (re-entrancy) queues into a fresh batch, not this one.
    const queue = this.eventQueue;
    this.eventQueue = [];
    for (const { handler, frame } of queue) handler(frame);
  }

  private failAllPending(): void {
    for (const pending of this.pending.values()) {
      pending.reject({ code: "INTERNAL", message: "connection lost" });
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS
    );
    this.reconnectAttempt += 1;
    setTimeout(() => {
      if (!this.closedByUser) this.connect();
    }, delay);
  }

  private emitStatus(state: Parameters<StatusHandler>[0]): void {
    for (const handler of this.statusHandlers) handler(state);
  }
}

function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === "*" || pattern === topic) return true;
  if (pattern.endsWith(".*")) return topic.startsWith(pattern.slice(0, -1));
  return false;
}

/**
 * Legacy single-agent discovery: the agent's own WebHost global, or the dev
 * define / manual paste. Under the supervisor the bridge endpoint is set at
 * runtime via setEndpoint(), so this returns null and is simply unused.
 */
function defaultBridgeEndpoint(): { url: string; token: string } | null {
  const injected = window.__ATELIER_BRIDGE__;
  if (injected?.port && injected.token) {
    return { url: `ws://127.0.0.1:${injected.port}`, token: injected.token };
  }
  const port =
    __ATELIER_BRIDGE_PORT__ || localStorage.getItem("atelier.port") || "";
  const token =
    __ATELIER_BRIDGE_TOKEN__ || localStorage.getItem("atelier.token") || "";
  if (!port || !token) return null;
  return { url: `ws://127.0.0.1:${port}`, token };
}

export const bridge = new BridgeClient({
  resolveEndpoint: defaultBridgeEndpoint,
});
