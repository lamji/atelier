import type {
  BridgeError,
  EventFrame,
  MethodName,
  MethodParams,
  MethodResult,
  PortClientFrame,
  PortServerFrame,
} from "@atelier/protocol";

export type EventHandler = (frame: EventFrame) => void;

/**
 * The old five-state WS machine collapses on a native transport: a port is
 * either live or not. "connecting" only exists between attach() and the
 * agent's ready frame.
 */
export type ConnectionState = "disconnected" | "connecting" | "connected";

/**
 * How long a call may wait for a port before it is treated as a failure.
 * Sized for a cold agent boot (fork + native module load + schema), which is
 * seconds, not milliseconds — but bounded, so a dead agent still surfaces.
 */
const CONNECT_GRACE_MS = 45_000;

/** An rpc() waiting for a port, or on its way to one. */
interface QueuedCall {
  method: string;
  params: unknown;
  onProgress?: Pending["onProgress"];
  resolve: (value: unknown) => void;
  reject: (error: BridgeError) => void;
  timer?: ReturnType<typeof setTimeout>;
}
export type StatusHandler = (state: ConnectionState) => void;

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
}

/**
 * The renderer's RPC client for one project agent, over an Electron
 * MessagePort handed in by the desktop main process (see desktop-port.ts).
 *
 * The public shape (rpc / subscribe / onStatus / cancel) is unchanged from
 * the WebSocket era, so the ~50 call sites across the app did not move.
 * What is gone: token handshake, seq replay, reconnect backoff — a dead
 * port means the agent died, and that is surfaced as "disconnected" for
 * the workspace screen to handle by re-attaching.
 */
export class BridgeClient {
  private port: MessagePort | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private subs = new Map<string, SubEntry>();
  private statusHandlers = new Set<StatusHandler>();
  private state: ConnectionState = "disconnected";
  /** Event frames queued for the next coalesced flush (see onFrame). */
  private eventQueue: Array<{ handler: EventHandler; frame: EventFrame }> = [];
  /** Monotonic stamp for arriving events — see where it is assigned. */
  private eventSeq = 0;
  private flushHandle: number | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Calls made before a port existed; replayed by setPort(). */
  private queued: QueuedCall[] = [];

  /**
   * Adopt a fresh port from projects.attach(). Any previous port is closed
   * first; subscriptions carry over (they are renderer-side filters — the
   * agent broadcasts everything).
   */
  setPort(port: MessagePort): void {
    // Take the queue out of the way first: disconnect() is a teardown and
    // drops it, but these calls were made *waiting for this very port*.
    const queued = this.queued;
    this.queued = [];
    this.disconnect();
    this.port = port;
    this.setState("connecting");
    port.onmessage = (event) => this.onFrame(event.data as PortServerFrame);
    // A closed channel delivers no event in the renderer; the agent process
    // exiting is reported out-of-band via projects.onChanged.
    port.start();
    for (const call of queued) this.send(call);
  }

  /**
   * Declare that a port is on its way. The shell is raised before the agent
   * has forked, and without this the bar would read a red "Disconnected"
   * through every normal launch — which is both alarming and wrong. There is
   * a connection coming; this says so.
   */
  expectPort(): void {
    if (!this.port) this.setState("connecting");
  }

  /**
   * Reject everything waiting for a port. Used when leaving the workspace,
   * where the port those calls were queued for is never going to arrive.
   */
  dropQueued(): void {
    const queued = this.queued;
    this.queued = [];
    for (const call of queued) {
      clearTimeout(call.timer);
      call.reject({ code: "INTERNAL", message: "bridge not connected" });
    }
  }

  disconnect(): void {
    const port = this.port;
    this.port = null;
    if (port) {
      port.onmessage = null;
      port.close();
    }
    this.failAllPending();
    this.clearEventQueue();
    this.setState("disconnected");
  }

  get connected(): boolean {
    return this.state === "connected";
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
    return new Promise((resolve, reject) => {
      const call: QueuedCall = {
        method,
        params,
        onProgress,
        resolve: resolve as (v: unknown) => void,
        reject,
      };
      if (this.port) {
        this.send(call);
        return;
      }
      /*
       * No port yet. The workspace shell is now mounted while its agent is
       * still booting, so the panels' first reads legitimately run before the
       * port exists — rejecting them outright made every panel render an
       * error it would never retry. They wait instead, and setPort() replays
       * them. The timeout is the backstop: an agent that never arrives must
       * surface as a failed call, not a promise that hangs forever.
       */
      call.timer = setTimeout(() => {
        this.queued = this.queued.filter((c) => c !== call);
        reject({ code: "INTERNAL", message: "bridge not connected" });
      }, CONNECT_GRACE_MS);
      this.queued.push(call);
    });
  }

  /** Assign an id, register it as in-flight, and put it on the wire. */
  private send(call: QueuedCall): void {
    if (call.timer !== undefined) clearTimeout(call.timer);
    const port = this.port;
    if (!port) {
      call.reject({ code: "INTERNAL", message: "bridge not connected" });
      return;
    }
    const id = this.nextId++;
    this.pending.set(id, {
      resolve: call.resolve,
      reject: call.reject,
      onProgress: call.onProgress,
    });
    const frame: PortClientFrame = {
      kind: "rpc",
      id,
      method: call.method,
      params: call.params,
    };
    port.postMessage(frame);
  }

  cancel(requestId: number): void {
    const frame: PortClientFrame = { kind: "cancel", id: requestId };
    this.port?.postMessage(frame);
  }

  /**
   * Subscribe to a topic pattern. Purely renderer-side: the agent sends
   * every event over the port and this filters. Subscriptions persist
   * across setPort() calls (project switches).
   */
  subscribe(topic: string, handler: EventHandler): () => void {
    const subId = `sub_${this.nextId++}`;
    this.subs.set(subId, { topic, handler });
    return () => {
      this.subs.delete(subId);
    };
  }

  private onFrame(frame: PortServerFrame): void {
    if (frame.kind === "ready") {
      this.setState("connected");
    } else if (frame.kind === "result") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      if (frame.ok) {
        pending.resolve(frame.result);
      } else {
        pending.reject({
          code: frame.error.code as BridgeError["code"],
          message: frame.error.message,
        });
      }
    } else if (frame.kind === "progress") {
      this.pending.get(frame.id)?.onProgress?.(
        frame.value as Parameters<NonNullable<Pending["onProgress"]>>[0]
      );
    } else if (frame.kind === "event") {
      const eventFrame: EventFrame = {
        kind: "event",
        topic: frame.topic,
        // Counted here, not carried over the port: the native transport
        // has no replay to sequence, but consumers still key off seq. With
        // every event stamped 0, pinned chat logs collided into duplicate
        // React keys and same-millisecond timeline entries deduped each
        // other away — dropped, not just noisy.
        seq: ++this.eventSeq,
        ts: frame.ts,
        taskId: frame.taskId,
        payload: frame.payload,
      };
      for (const entry of this.subs.values()) {
        if (topicMatches(entry.topic, frame.topic)) {
          this.eventQueue.push({ handler: entry.handler, frame: eventFrame });
        }
      }
      this.scheduleFlush();
    }
  }

  /**
   * Coalesces a burst of event frames into one flush per animation frame so
   * React auto-batching merges the resulting store updates into a single
   * render. A setTimeout safety net covers backgrounded windows, where rAF
   * is throttled/paused.
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

  private failAllPending(): void {
    for (const pending of this.pending.values()) {
      pending.reject({ code: "INTERNAL", message: "connection lost" });
    }
    this.pending.clear();
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const handler of this.statusHandlers) handler(state);
  }
}

function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === "*" || pattern === topic) return true;
  if (pattern.endsWith(".*")) return topic.startsWith(pattern.slice(0, -1));
  return false;
}

export const bridge = new BridgeClient();
