import type { Router } from "../bridge/router.js";
import type { PreviewSessionStore } from "./preview-session-store.js";
import type { PreviewCaptureBroker } from "./preview-capture-broker.js";
import type { PreviewTestBroker } from "./preview-test-broker.js";

/**
 * The renderer half of the preview bridge.
 *
 * `preview.session.*` is kept off the task pipeline on purpose: the session
 * carries credentials and never rides a prompt. `preview.capture.resolve`
 * is the renderer answering the agent's on-demand console request — console
 * text only, which is diagnostic output the model is meant to read.
 */
export function registerPreviewHandlers(
  router: Router,
  sessions: PreviewSessionStore,
  captures?: PreviewCaptureBroker,
  tests?: PreviewTestBroker
): void {
  router.register("preview.session.set", async (params) => {
    const reason = sessions.set(params);
    return reason ? { accepted: false, reason } : { accepted: true };
  });

  router.register("preview.session.clear", async (params) => ({
    cleared: sessions.clear(params?.origin),
  }));

  router.register("preview.capture.resolve", async (params) => ({
    ok:
      captures?.resolve(params.id, {
        capture: params.capture,
        reason: params.reason,
      }) ?? false,
  }));

  router.register("preview.test.resolve", async (params) => ({
    ok:
      tests?.resolve(params.id, {
        report: params.report,
        reason: params.reason,
      }) ?? false,
  }));
}
