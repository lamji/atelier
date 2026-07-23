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
  hello: { workspaceRoot: string; authStatus: string } | null = null;

  private getEndpoint(): { url: string; token: string } | null {
    const port =
      __ATELIER_BRIDGE_PORT__ || localStorage.getItem("atelier.port") || "";
    const token =
      __ATELIER_BRIDGE_TOKEN__ || localStorage.getItem("atelier.token") || "";
    if (!port || !token) return null;
    return { url: `ws://127.0.0.1:${port}`, token };
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
    this.ws?.close();
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
          entry.handler(frame);
        }
      }
    }
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

export const bridge = new BridgeClient();
