import type { WebSocket } from "ws";
import type { ServerFrame } from "@atelier/protocol";
import { newId } from "@atelier/shared";

export interface Subscription {
  subId: string;
  topicPattern: string;
  filter?: Record<string, unknown>;
}

/** Per-socket state: auth flag, subscriptions, in-flight request aborts. */
export class Connection {
  readonly id = newId("conn");
  authenticated = false;
  sessionId: string | null = null;
  readonly subscriptions = new Map<string, Subscription>();
  readonly inflight = new Map<string, AbortController>();

  constructor(private ws: WebSocket) {}

  send(frame: ServerFrame): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(frame));
  }

  close(code: number, reason: string): void {
    this.ws.close(code, reason);
  }

  abortAll(): void {
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
  }
}
