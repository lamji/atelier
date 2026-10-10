import { newId } from "@atelier/shared";
import type { PreviewTestReport, PreviewTestStep } from "@atelier/protocol";
import type { EventBus } from "../events/event-bus.js";

/**
 * A frontend test case runs against the live app the user is looking at, and a
 * whole test can involve several waits — so this is generous compared with the
 * console capture, but still bounded so a hung renderer can't park the turn.
 */
const TEST_TIMEOUT_MS = 90_000;

export interface PreviewTestAnswer {
  report: PreviewTestReport | null;
  reason?: string;
}

/**
 * The agent's half of the frontend-review test bridge.
 *
 * The agent authors a test case; this ships it to the renderer, which drives
 * it against the in-app preview iframe and answers with the per-step results.
 * No user interaction is involved, so the deadline only covers a renderer that
 * never answers.
 */
export class PreviewTestBroker {
  private pending = new Map<string, (answer: PreviewTestAnswer) => void>();

  constructor(private bus: EventBus) {}

  /** Called by the RPC handler; false when nothing was waiting on `id`. */
  resolve(id: string, answer: PreviewTestAnswer): boolean {
    const settle = this.pending.get(id);
    if (!settle) return false;
    settle(answer);
    return true;
  }

  run(
    taskId: string,
    test: { title: string; url: string | null; steps: PreviewTestStep[] },
    signal?: AbortSignal
  ): Promise<PreviewTestAnswer> {
    const id = newId("pvtest");
    this.bus.publish(
      "preview.test.requested",
      {
        id,
        title: test.title,
        url: test.url,
        steps: test.steps,
        expiresAt: Date.now() + TEST_TIMEOUT_MS,
      },
      taskId
    );
    return new Promise<PreviewTestAnswer>((resolve) => {
      let done = false;
      const settle = (answer: PreviewTestAnswer): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        this.bus.publish(
          "preview.test.resolved",
          {
            id,
            ok: answer.report !== null,
            status: answer.report?.status ?? "unavailable",
            reason: answer.reason,
          },
          taskId
        );
        resolve(answer);
      };
      const onAbort = (): void =>
        settle({ report: null, reason: "the task was cancelled" });
      const timer = setTimeout(
        () =>
          settle({
            report: null,
            reason:
              "Page preview did not finish the test — it is not open, or this " +
              "is not the desktop app.",
          }),
        TEST_TIMEOUT_MS
      );
      this.pending.set(id, settle);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
