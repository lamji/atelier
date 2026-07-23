import type { EventFrame } from "@atelier/protocol";
import type { Db } from "../storage/db.js";
import type { EventBus, PublishedEvent } from "./event-bus.js";

/** Topics too chatty to persist frame-by-frame. */
const EPHEMERAL_TOPICS = new Set<string>([
  "terminal.data",
  "chat.message.delta",
  "agent.thinking.delta",
]);

/**
 * Persists every (non-ephemeral) event to SQLite. Powers task.getTimeline
 * and reconnect replay.
 */
export class TimelineStore {
  private insert;

  constructor(private db: Db, bus: EventBus) {
    this.insert = db.prepare(
      "INSERT INTO timeline(task_id, topic, seq, ts, payload) VALUES(?, ?, ?, ?, ?)"
    );
    bus.subscribe((event) => this.onEvent(event));
  }

  private onEvent(event: PublishedEvent): void {
    if (EPHEMERAL_TOPICS.has(event.topic)) return;
    this.insert.run(
      event.taskId ?? null,
      event.topic,
      event.seq,
      event.ts,
      JSON.stringify(event.payload ?? null)
    );
  }

  getTimeline(
    taskId: string,
    cursor?: number,
    limit = 200
  ): { entries: EventFrame[]; nextCursor: number | null } {
    const rows = this.db
      .prepare(
        "SELECT id, task_id, topic, seq, ts, payload FROM timeline " +
          "WHERE task_id = ? AND id > ? ORDER BY id LIMIT ?"
      )
      .all(taskId, cursor ?? 0, limit) as TimelineRow[];
    const entries: EventFrame[] = rows.map((r) => ({
      kind: "event",
      topic: r.topic,
      seq: r.seq,
      ts: r.ts,
      taskId: r.task_id ?? undefined,
      payload: JSON.parse(r.payload),
    }));
    const last = rows[rows.length - 1];
    return {
      entries,
      nextCursor: rows.length === limit && last ? last.id : null,
    };
  }

  /** Replay events on a topic with seq greater than `since`. */
  replayTopic(topic: string, since: number, limit = 500): EventFrame[] {
    const rows = this.db
      .prepare(
        "SELECT id, task_id, topic, seq, ts, payload FROM timeline " +
          "WHERE topic = ? AND seq > ? ORDER BY seq LIMIT ?"
      )
      .all(topic, since, limit) as TimelineRow[];
    return rows.map((r) => ({
      kind: "event",
      topic: r.topic,
      seq: r.seq,
      ts: r.ts,
      taskId: r.task_id ?? undefined,
      payload: JSON.parse(r.payload),
    }));
  }
}

interface TimelineRow {
  id: number;
  task_id: string | null;
  topic: string;
  seq: number;
  ts: number;
  payload: string;
}
