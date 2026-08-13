import type { EventPayload, EventTopic } from "@atelier/protocol";
import { eventPayloads } from "@atelier/protocol";

export interface PublishedEvent {
  topic: EventTopic;
  seq: number;
  ts: number;
  taskId?: string;
  payload: unknown;
}

export type EventListener = (event: PublishedEvent) => void;

/**
 * Per-token topics, exempt from payload validation.
 *
 * Both are producer-built in this process (never user or wire input), both
 * are already in the timeline store's EPHEMERAL_TOPICS so nothing persists
 * them, and both fire once per streamed token.
 */
const HOT_TOPICS = new Set<string>([
  "chat.message.delta",
  "agent.thinking.delta",
]);

/**
 * Typed in-process pub/sub. Every service publishes here; the bridge event
 * hub and the timeline store are just subscribers. Payloads are validated
 * against the protocol schema before leaving the process boundary.
 */
export class EventBus {
  private listeners = new Set<EventListener>();
  private seqByTopic = new Map<string, number>();

  publish<T extends EventTopic>(
    topic: T,
    payload: EventPayload<T>,
    taskId?: string
  ): PublishedEvent {
    // Validation is a guard on the process boundary, and it earns its cost
    // on events published once per stage. These two are published once per
    // TOKEN — thousands per turn, on the same thread that has to keep the
    // stream moving — to re-confirm a two-field object this file's own
    // callers just built. The schema still types them at the call site.
    const parsed = HOT_TOPICS.has(topic)
      ? payload
      : eventPayloads[topic].parse(payload);
    const seq = (this.seqByTopic.get(topic) ?? 0) + 1;
    this.seqByTopic.set(topic, seq);
    const event: PublishedEvent = {
      topic,
      seq,
      ts: Date.now(),
      taskId,
      payload: parsed,
    };
    for (const listener of this.listeners) listener(event);
    return event;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
