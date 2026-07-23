import { topicMatches } from "@atelier/protocol";
import type { EventBus } from "../events/event-bus.js";
import type { TimelineStore } from "../events/timeline-store.js";
import type { Connection, Subscription } from "./connection.js";

/**
 * Fans internal bus events out to subscribed sockets, and serves replay
 * (`since` seq) from the timeline store on subscribe.
 */
export class EventHub {
  private connections = new Set<Connection>();

  constructor(bus: EventBus, private timeline: TimelineStore) {
    bus.subscribe((event) => {
      for (const conn of this.connections) {
        if (!conn.authenticated) continue;
        for (const sub of conn.subscriptions.values()) {
          if (topicMatches(sub.topicPattern, event.topic)) {
            conn.send({
              kind: "event",
              topic: event.topic,
              seq: event.seq,
              ts: event.ts,
              taskId: event.taskId,
              payload: event.payload,
            });
            break;
          }
        }
      }
    });
  }

  attach(conn: Connection): void {
    this.connections.add(conn);
  }

  detach(conn: Connection): void {
    this.connections.delete(conn);
  }

  subscribe(
    conn: Connection,
    subId: string,
    topicPattern: string,
    filter?: Record<string, unknown>,
    since?: number
  ): Subscription {
    const sub: Subscription = { subId, topicPattern, filter };
    conn.subscriptions.set(subId, sub);
    if (since !== undefined && !topicPattern.includes("*")) {
      for (const frame of this.timeline.replayTopic(topicPattern, since)) {
        conn.send(frame);
      }
    }
    return sub;
  }

  unsubscribe(conn: Connection, subId: string): void {
    conn.subscriptions.delete(subId);
  }
}
