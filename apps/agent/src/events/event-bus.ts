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
    const schema = eventPayloads[topic];
    const parsed = schema.parse(payload);
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
