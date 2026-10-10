import { newId } from "@atelier/shared";
import type { PreviewConsoleCapture } from "@atelier/protocol";
import type { EventBus } from "../events/event-bus.js";

/** How long a capture waits for the renderer before it is reported absent. */
const CAPTURE_TIMEOUT_MS = 8_000;

export interface PreviewCaptureAnswer {
  capture: PreviewConsoleCapture | null;
  reason?: string;
}

/**
 * The agent's half of the on-demand preview console bridge.
 *
 * The renderer already lifts the displayed iframe's console out through the
 * desktop bridge — it rides every send as hidden context. What was missing
 * was the model being able to ASK for it mid-turn, after reproducing the
 * failure, signed in as the user. So a request goes out as an event, the
 * renderer reads the iframe and answers over RPC, and the parked tool call
 * resumes with the console. No user interaction is involved; the deadline
 * only covers a renderer that is not there.
 */
export class PreviewCaptureBroker {
  private pending = new Map<string, (answer: PreviewCaptureAnswer) => void>();

  constructor(private bus: EventBus) {}

  /** Called by the RPC handler; false when nothing was waiting on `id`. */
  resolve(id: string, answer: PreviewCaptureAnswer): boolean {
    const settle = this.pending.get(id);
    if (!settle) return false;
    settle(answer);
    return true;
  }

  request(
    taskId: string,
    url: string | null,
    signal?: AbortSignal
  ): Promise<PreviewCaptureAnswer> {
    const id = newId("pvcap");
    this.bus.publish(
      "preview.capture.requested",
      { id, url, expiresAt: Date.now() + CAPTURE_TIMEOUT_MS },
      taskId
    );
    return new Promise<PreviewCaptureAnswer>((resolve) => {
      let done = false;
      const settle = (answer: PreviewCaptureAnswer): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        this.bus.publish(
          "preview.capture.resolved",
          { id, ok: answer.capture !== null, reason: answer.reason },
          taskId
        );
        resolve(answer);
      };
      const onAbort = (): void =>
        settle({ capture: null, reason: "the task was cancelled" });
      const timer = setTimeout(
        () =>
          settle({
            capture: null,
            reason:
              "Page preview did not answer — it is not open, or this is not " +
              "the desktop app.",
          }),
        CAPTURE_TIMEOUT_MS
      );
      this.pending.set(id, settle);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
